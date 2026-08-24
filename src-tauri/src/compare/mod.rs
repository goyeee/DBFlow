//! 结构对比引擎：双端快照 → 差异项列表（纯函数，可单测；一源多目标时可直接复用）。
pub mod sqlgen;

use std::collections::BTreeMap;

use serde::Serialize;

use crate::datasource::{ColumnDef, IndexDef, SchemaSnapshot, TableDef};
use sqlgen::{create_table_sql, describe_column, describe_index, describe_table_options};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Table,
    Column,
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffAction {
    Create,
    Drop,
    Modify,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffItem {
    /// 稳定标识：tbl:{表} / tblopt:{表} / col:{表}:{列} / idx:{表}:{索引}
    pub id: String,
    pub kind: DiffKind,
    pub action: DiffAction,
    pub table: String,
    pub name: String,
    /// 源端形态描述（drop 类为 None）
    pub source_desc: Option<String>,
    /// 目标端形态描述（create 类为 None）
    pub target_desc: Option<String>,
    /// 在目标端执行的 SQL
    pub sql: Option<String>,
    /// 破坏性操作（DROP 表/列/索引）→ 前端红色标注 + 默认不勾选
    pub dangerous: bool,
    /// 源端该表完整建表 DDL（DDL 对比视图用；表在源端不存在时为 None）
    pub source_ddl: Option<String>,
    /// 目标端该表完整建表 DDL（表在目标端不存在时为 None）
    pub target_ddl: Option<String>,
}

/// 源快照 vs 目标快照 → 差异项（目标端如何变更才能与源一致）
pub fn diff_snapshots(source: &SchemaSnapshot, target: &SchemaSnapshot) -> Vec<DiffItem> {
    let src: BTreeMap<&str, &TableDef> = source.tables.iter().map(|t| (t.name.as_str(), t)).collect();
    let tgt: BTreeMap<&str, &TableDef> = target.tables.iter().map(|t| (t.name.as_str(), t)).collect();

    let mut items = Vec::new();

    // 所有生成的 SQL 都在目标端执行 → 库前缀一律用目标库名；
    // DDL 对比视图用各端真实库名生成完整建表语句
    for (name, s) in &src {
        let src_ddl = create_table_sql(&source.database, s);
        match tgt.get(*name) {
            None => items.push(table_create(&target.database, s, &src_ddl)),
            Some(t) => {
                let tgt_ddl = create_table_sql(&target.database, t);
                items.extend(diff_table(&target.database, s, t, &src_ddl, &tgt_ddl));
            }
        }
    }
    for (name, t) in &tgt {
        if !src.contains_key(*name) {
            let tgt_ddl = create_table_sql(&target.database, t);
            items.push(table_drop(&target.database, t, &tgt_ddl));
        }
    }
    items
}

fn table_create(db: &str, s: &TableDef, src_ddl: &str) -> DiffItem {
    DiffItem {
        id: format!("tbl:{}", s.name),
        kind: DiffKind::Table,
        action: DiffAction::Create,
        table: s.name.clone(),
        name: s.name.clone(),
        source_desc: Some(describe_table_options(s)),
        target_desc: None,
        sql: Some(create_table_sql(db, s)),
        dangerous: false,
        source_ddl: Some(src_ddl.to_string()),
        target_ddl: None,
    }
}

fn table_drop(db: &str, t: &TableDef, tgt_ddl: &str) -> DiffItem {
    DiffItem {
        id: format!("tbl:{}", t.name),
        kind: DiffKind::Table,
        action: DiffAction::Drop,
        table: t.name.clone(),
        name: t.name.clone(),
        source_desc: None,
        target_desc: Some(format!("{} 张表，待删除", t.columns.len())),
        sql: Some(format!("DROP TABLE {}", sqlgen::qualified(db, &t.name))),
        dangerous: true,
        source_ddl: None,
        target_ddl: Some(tgt_ddl.to_string()),
    }
}

fn diff_table(db: &str, s: &TableDef, t: &TableDef, src_ddl: &str, tgt_ddl: &str) -> Vec<DiffItem> {
    let mut items = Vec::new();
    let mk = |id: String, kind: DiffKind, action: DiffAction, name: String,
              source_desc: Option<String>, target_desc: Option<String>,
              sql: Option<String>, dangerous: bool| DiffItem {
        id, kind, action,
        table: s.name.clone(),
        name,
        source_desc, target_desc, sql, dangerous,
        source_ddl: Some(src_ddl.to_string()),
        target_ddl: Some(tgt_ddl.to_string()),
    };

    // 表选项（ENGINE / COMMENT；字符集差异仅描述不生成 SQL——CONVERT 风险高，后续版本做）
    if s.engine != t.engine || s.comment != t.comment {
        let mut alter = format!("ALTER TABLE {}", sqlgen::qualified(db, &s.name));
        if s.engine != t.engine {
            if let Some(e) = &s.engine {
                alter.push_str(&format!(" ENGINE={e}"));
            }
        }
        if s.comment != t.comment {
            alter.push_str(&format!(
                " COMMENT={}",
                sqlgen::quote_string(s.comment.as_deref().unwrap_or(""))
            ));
        }
        items.push(mk(
            format!("tblopt:{}", s.name),
            DiffKind::Table,
            DiffAction::Modify,
            "(表选项)".to_string(),
            Some(describe_table_options(s)),
            Some(describe_table_options(t)),
            Some(alter),
            false,
        ));
    }

    // 列
    let src_cols: BTreeMap<&str, &ColumnDef> =
        s.columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let tgt_cols: BTreeMap<&str, &ColumnDef> =
        t.columns.iter().map(|c| (c.name.as_str(), c)).collect();

    for (name, sc) in &src_cols {
        match tgt_cols.get(*name) {
            None => {
                // 新增列：定位到源中前一列，用 AFTER 保持位置
                let pos = s.columns.iter().position(|c| c.name == *name);
                let after = pos
                    .and_then(|p| p.checked_sub(1))
                    .and_then(|p| s.columns.get(p))
                    .map(|c| c.name.clone());
                items.push(mk(
                    format!("col:{}:{}", s.name, name),
                    DiffKind::Column,
                    DiffAction::Create,
                    name.to_string(),
                    Some(describe_column(sc)),
                    None,
                    Some(sqlgen::add_column_sql(db, &s.name, sc, after.as_deref())),
                    false,
                ));
            }
            Some(tc) if !cols_equal(sc, tc) => {
                items.push(mk(
                    format!("col:{}:{}", s.name, name),
                    DiffKind::Column,
                    DiffAction::Modify,
                    name.to_string(),
                    Some(describe_column(sc)),
                    Some(describe_column(tc)),
                    Some(sqlgen::modify_column_sql(db, &s.name, sc)),
                    false,
                ));
            }
            _ => {}
        }
    }
    for (name, tc) in &tgt_cols {
        if !src_cols.contains_key(*name) {
            items.push(mk(
                format!("col:{}:{}", s.name, name),
                DiffKind::Column,
                DiffAction::Drop,
                name.to_string(),
                None,
                Some(describe_column(tc)),
                Some(sqlgen::drop_column_sql(db, &s.name, name)),
                true,
            ));
        }
    }

    // 索引
    let src_idx: BTreeMap<&str, &IndexDef> =
        s.indexes.iter().map(|i| (i.name.as_str(), i)).collect();
    let tgt_idx: BTreeMap<&str, &IndexDef> =
        t.indexes.iter().map(|i| (i.name.as_str(), i)).collect();

    for (name, si) in &src_idx {
        match tgt_idx.get(*name) {
            None => items.push(mk(
                format!("idx:{}:{}", s.name, name),
                DiffKind::Index,
                DiffAction::Create,
                name.to_string(),
                Some(describe_index(si)),
                None,
                Some(sqlgen::add_index_sql(db, &s.name, si)),
                false,
            )),
            Some(ti) if si != ti => items.push(mk(
                format!("idx:{}:{}", s.name, name),
                DiffKind::Index,
                DiffAction::Modify,
                name.to_string(),
                Some(describe_index(si)),
                Some(describe_index(ti)),
                // MySQL 无法原地改索引：DROP + ADD 合并为一条 ALTER
                Some(sqlgen::rebuild_index_sql(db, &s.name, si)),
                false,
            )),
            _ => {}
        }
    }
    for (name, ti) in &tgt_idx {
        if !src_idx.contains_key(*name) {
            items.push(mk(
                format!("idx:{}:{}", s.name, name),
                DiffKind::Index,
                DiffAction::Drop,
                name.to_string(),
                None,
                Some(describe_index(ti)),
                Some(sqlgen::drop_index_sql(db, &s.name, ti)),
                true,
            ));
        }
    }

    items
}

/// 列语义等价（忽略 ordinal —— 位置差异不算修改）
fn cols_equal(a: &ColumnDef, b: &ColumnDef) -> bool {
    a.name == b.name
        && a.data_type == b.data_type
        && a.nullable == b.nullable
        && a.default == b.default
        && a.extra == b.extra
        && a.comment == b.comment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, dt: &str, nullable: bool) -> ColumnDef {
        ColumnDef { name: name.into(), data_type: dt.into(), nullable, ..Default::default() }
    }

    fn table(name: &str, columns: Vec<ColumnDef>, indexes: Vec<IndexDef>) -> TableDef {
        TableDef { name: name.into(), engine: Some("InnoDB".into()), ..Default::default() }
            .with_columns(columns)
            .with_indexes(indexes)
    }

    // 小构造器
    impl TableDef {
        fn with_columns(mut self, cols: Vec<ColumnDef>) -> Self {
            self.columns = cols
                .into_iter()
                .enumerate()
                .map(|(i, mut c)| {
                    c.ordinal = (i + 1) as u32;
                    c
                })
                .collect();
            self
        }
        fn with_indexes(mut self, idx: Vec<IndexDef>) -> Self {
            self.indexes = idx;
            self
        }
    }

    fn snap(db: &str, tables: Vec<TableDef>) -> SchemaSnapshot {
        SchemaSnapshot { database: db.into(), tables }
    }

    #[test]
    fn identical_snapshots_produce_no_diff() {
        let a = snap(
            "src",
            vec![table(
                "t1",
                vec![col("id", "bigint unsigned", false), col("name", "varchar(64)", true)],
                vec![IndexDef { name: "PRIMARY".into(), is_primary: true, columns: vec!["id".into()], unique: true, index_type: Some("BTREE".into()) }],
            )],
        );
        let b = snap("tgt", a.tables.clone());
        assert!(diff_snapshots(&a, &b).is_empty());
    }

    #[test]
    fn table_create_and_drop() {
        let src = snap("src", vec![table("t1", vec![col("id", "int", false)], vec![])]);
        let tgt = snap("tgt", vec![table("extra", vec![col("id", "int", false)], vec![])]);
        let items = diff_snapshots(&src, &tgt);
        assert_eq!(items.len(), 2);
        let create = items.iter().find(|i| i.id == "tbl:t1").unwrap();
        assert_eq!(create.action, DiffAction::Create);
        assert!(!create.dangerous);
        assert!(create.sql.as_ref().unwrap().starts_with("CREATE TABLE `tgt`.`t1`"));
        let drop = items.iter().find(|i| i.id == "tbl:extra").unwrap();
        assert_eq!(drop.action, DiffAction::Drop);
        assert!(drop.dangerous);
        assert_eq!(drop.sql.as_deref(), Some("DROP TABLE `tgt`.`extra`"));
    }

    #[test]
    fn column_add_modify_drop() {
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![
                    col("id", "bigint", false),
                    col("name", "varchar(255)", false),
                    col("remark", "text", true),
                ],
                vec![],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![
                    col("id", "bigint", false),
                    col("name", "varchar(64)", false), // 类型不同 → Modify
                    col("legacy", "int", true),         // 目标多余 → Drop
                ],
                vec![],
            )],
        );
        let items = diff_snapshots(&src, &tgt);
        assert_eq!(items.len(), 3, "{items:?}");

        let add = items.iter().find(|i| i.id == "col:t:remark").unwrap();
        assert_eq!(add.action, DiffAction::Create);
        // AFTER 定位到源中前一列 name
        assert!(add.sql.as_deref().unwrap().contains("AFTER `name`"));

        let modify = items.iter().find(|i| i.id == "col:t:name").unwrap();
        assert_eq!(modify.action, DiffAction::Modify);
        assert!(modify.sql.as_deref().unwrap().contains("MODIFY COLUMN"));
        assert_eq!(modify.source_desc.as_deref(), Some("varchar(255) NOT NULL"));

        let drop = items.iter().find(|i| i.id == "col:t:legacy").unwrap();
        assert_eq!(drop.action, DiffAction::Drop);
        assert!(drop.dangerous);
        assert!(drop.sql.as_deref().unwrap().contains("DROP COLUMN"));
    }

    #[test]
    fn first_added_column_uses_first_clause() {
        // 源里 a 是第一列 → 新增到目标时用 FIRST
        let src = snap("src", vec![table("t", vec![col("a", "int", true), col("id", "int", false)], vec![])]);
        let tgt = snap("tgt", vec![table("t", vec![col("id", "int", false)], vec![])]);
        let items = diff_snapshots(&src, &tgt);
        let add = items.iter().find(|i| i.id == "col:t:a").unwrap();
        let sql = add.sql.as_deref().unwrap();
        assert!(sql.ends_with("FIRST"), "{sql}");
        // 中间列用 AFTER 前一列
        let add_id = items.iter().find(|i| i.id == "col:t:id");
        assert!(add_id.is_none(), "id 已存在不应有差异项");
    }

    #[test]
    fn index_diffs() {
        let idx = |name: &str, cols: &[&str], unique: bool| IndexDef {
            name: name.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            unique,
            is_primary: name == "PRIMARY",
            index_type: Some("BTREE".into()),
        };
        let src = snap(
            "src",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_new", &["a"], false)],
            )],
        );
        let tgt = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_old", &["b"], false)],
            )],
        );
        let items = diff_snapshots(&src, &tgt);
        assert_eq!(items.len(), 2);
        let add = items.iter().find(|i| i.id == "idx:t:idx_new").unwrap();
        assert!(add.sql.as_deref().unwrap().contains("ADD INDEX `idx_new` (`a`)"));
        let drop = items.iter().find(|i| i.id == "idx:t:idx_old").unwrap();
        assert!(drop.dangerous);

        // 同名不同列 → Modify（DROP+ADD 同语句）
        let tgt2 = snap(
            "tgt",
            vec![table(
                "t",
                vec![col("id", "int", false), col("a", "int", true), col("b", "int", true)],
                vec![idx("PRIMARY", &["id"], true), idx("idx_new", &["b"], false)],
            )],
        );
        let items2 = diff_snapshots(&src, &tgt2);
        assert_eq!(items2.len(), 1);
        let m = &items2[0];
        assert_eq!(m.action, DiffAction::Modify);
        let sql = m.sql.as_deref().unwrap();
        assert!(sql.contains("DROP INDEX `idx_new`") && sql.contains("ADD INDEX `idx_new` (`a`)"), "{sql}");
    }

    #[test]
    fn table_options_diff() {
        let mut src_t = table("t", vec![col("id", "int", false)], vec![]);
        src_t.comment = Some("新注释".into());
        let mut tgt_t = table("t", vec![col("id", "int", false)], vec![]);
        tgt_t.comment = Some("旧注释".into());
        tgt_t.engine = Some("MyISAM".into());
        let items = diff_snapshots(&snap("src", vec![src_t]), &snap("tgt", vec![tgt_t]));
        assert_eq!(items.len(), 1);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("ENGINE=InnoDB") && sql.contains("COMMENT='新注释'"), "{sql}");
    }

    #[test]
    fn ordinal_change_alone_is_not_a_diff() {
        // 列对比忽略 ordinal：相同列集合（无论顺序）不产生差异
        let t = table("t", vec![col("id", "int", false), col("x", "int", true)], vec![]);
        let items = diff_snapshots(&snap("s", vec![t.clone()]), &snap("t", vec![t]));
        assert!(items.is_empty());
    }

    // ───────────────── e2e：docker/testenv（DBFLOW_E2E=1） ─────────────────

    mod e2e {
        use super::super::diff_snapshots;
        use crate::config::model::{ConnectionProfile, DatabaseKind, SshAuth, SshTunnelConfig};
        use crate::datasource::mysql::{self, ConnectEndpoint, MySqlLive};
        use crate::datasource::LiveConnection;
        use crate::tunnel::{HostKeyPolicy, SshCredential, TunnelManager};

        fn enabled() -> bool {
            std::env::var("DBFLOW_E2E").is_ok()
        }

        fn profile(host: &str, port: u16, pw: &str) -> ConnectionProfile {
            ConnectionProfile {
                id: uuid::Uuid::new_v4(),
                name: "e2e-compare".into(),
                group_id: None,
                color: None,
                db: DatabaseKind::MySql,
                host: host.into(),
                port,
                user: "root".into(),
                default_database: None,
                has_password: true,
                ssh_has_password: false,
                options: Default::default(),
                ssh: None,
                created_at: 0,
                updated_at: 0,
            }
        }

        /// mysql-a(直连) 作为源，经 SSH 隧道连 mysql-b 作为目标：
        /// 测试自建 db_shop_old（源库的"旧版本"），对比 → 全量部署 → 复比为空
        #[tokio::test]
        async fn e2e_compare_roundtrip_via_tunnel() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            // 源：mysql-a 直连
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let src = MySqlLive::new(pool_a, None);

            // 目标：mysql-b 经跳板
            let manager = TunnelManager::default();
            let ssh_cfg = SshTunnelConfig {
                host: "127.0.0.1".into(),
                port: 2222,
                user: "dbjump".into(),
                auth: SshAuth::Password,
                target_host_override: Some("mysql-b".into()),
            };
            let cred = SshCredential::Password("dbflow-jump-2026".into());
            let no_policy = HostKeyPolicy { trusted_fingerprint: None, use_known_hosts: false };
            let fingerprint = match manager.acquire(&ssh_cfg, "mysql-b", 3306, &cred, no_policy).await {
                Err(crate::error::AppError::HostKeyUnknown { fingerprint }) => fingerprint,
                other => panic!("首次未信任应报 HostKeyUnknown，实际 {:?}", other.map(|_| ())),
            };
            let lease = manager
                .acquire(&ssh_cfg, "mysql-b", 3306, &cred, HostKeyPolicy {
                    trusted_fingerprint: Some(fingerprint),
                    use_known_hosts: false,
                })
                .await
                .expect("隧道建立失败");
            let (t_host, t_port) = lease.endpoint();
            let endpoint_b = ConnectEndpoint { host: t_host, port: t_port };
            let pool_b = mysql::open_pool(&profile("mysql-b", 3306, ""), &endpoint_b, Some("dbflow-b-2026"))
                .await
                .expect("经隧道连接 mysql-b 失败");
            let tgt = MySqlLive::new(pool_b, Some(lease));

            // 在目标端自建"旧版 db_shop"差异样本（幂等：先删后建）
            let fixture = [
                "DROP DATABASE IF EXISTS `db_shop_old`",
                "CREATE DATABASE `db_shop_old` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_shop_old`.`customer` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',\
                   `name` varchar(64) NOT NULL COMMENT '客户姓名',\
                   `phone` varchar(32) DEFAULT NULL COMMENT '手机号',\
                   `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',\
                   PRIMARY KEY (`id`), UNIQUE KEY `uk_phone` (`phone`)\
                 ) ENGINE=InnoDB COMMENT='客户表'",
                "CREATE TABLE `db_shop_old`.`orders` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '订单号',\
                   `customer_id` bigint unsigned NOT NULL COMMENT '客户ID',\
                   `amount` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT '金额',\
                   `remark` varchar(255) DEFAULT NULL COMMENT '备注',\
                   PRIMARY KEY (`id`), KEY `idx_amount` (`amount`)\
                 ) ENGINE=InnoDB COMMENT='订单'",
                "CREATE TABLE `db_shop_old`.`promo` (`id` int NOT NULL, `title` varchar(64), PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture {
                tgt.execute(sql).await.expect("建差异样本失败");
            }

            // 对比
            let snap_src = src.snapshot_schema("db_shop").await.expect("源快照");
            let snap_tgt = tgt.snapshot_schema("db_shop_old").await.expect("目标快照");
            let items = diff_snapshots(&snap_src, &snap_tgt);
            let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
            assert_eq!(
                ids,
                vec![
                    "col:customer:level",      // 缺列 → 新增
                    "col:customer:phone",      // varchar(20) vs varchar(32) → 修改
                    "tblopt:orders",           // 表注释不同
                    "col:orders:status",       // 缺列 → 新增
                    "col:orders:remark",       // 目标多余列 → 删除
                    "idx:orders:idx_customer", // 缺索引 → 新增
                    "idx:orders:idx_amount",   // 目标多余索引 → 删除
                    "tbl:promo",               // 目标多余表 → 删除
                ],
                "差异清单不符: {ids:?}"
            );
            assert!(items.iter().filter(|i| i.dangerous).count() == 3);

            // DDL 对比视图数据：每项带两端完整建表语句，缺端为 None
            let promo = items.iter().find(|i| i.id == "tbl:promo").unwrap();
            assert!(promo.source_ddl.is_none(), "目标独有表不应有源 DDL");
            assert!(promo.target_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop_old`.`promo`"));
            let phone = items.iter().find(|i| i.id == "col:customer:phone").unwrap();
            assert!(
                phone.source_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop`.`customer`")
                    && phone.source_ddl.as_deref().unwrap().contains("varchar(20)"),
                "源 DDL 应为源库名与源形态"
            );
            assert!(
                phone.target_ddl.as_deref().unwrap().contains("CREATE TABLE `db_shop_old`.`customer`")
                    && phone.target_ddl.as_deref().unwrap().contains("varchar(32)"),
                "目标 DDL 应为目标库名与目标形态"
            );

            // 全量部署（含危险项）→ 每条都应成功
            for item in &items {
                let sql = item.sql.as_deref().expect("每项都应有 SQL");
                tgt.execute(sql).await.unwrap_or_else(|e| panic!("执行失败 [{sql}]: {e}"));
            }

            // 复比应为空
            let snap_after = tgt.snapshot_schema("db_shop_old").await.expect("复比快照");
            let remain = diff_snapshots(&snap_src, &snap_after);
            assert!(remain.is_empty(), "部署后仍有差异: {:?}", remain.iter().map(|i| &i.id).collect::<Vec<_>>());

            // 清理
            tgt.execute("DROP DATABASE `db_shop_old`").await.unwrap();
            tgt.shutdown().await;
            src.shutdown().await;
        }

        /// 回归：5.6 上 list_databases/list_tables/describe_table 三件套
        /// （历史 bug：5.6 结果列名按 SELECT 原文回显，按大写名取值会静默丢行返回空）
        #[tokio::test]
        async fn e2e_mysql56_browse() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let live = MySqlLive::new(pool, None);

            let dbs = live.list_databases().await.expect("list_databases 失败");
            let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
            assert!(names.contains(&"db_shop"), "5.6 库列表不含 db_shop: {names:?}");

            let tables = live.list_tables("db_shop").await.expect("list_tables 失败");
            let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
            assert!(tnames.contains(&"customer") && tnames.contains(&"orders"), "{tnames:?}");
            let customer = tables.iter().find(|t| t.name == "customer").unwrap();
            assert_eq!(customer.comment.as_deref(), Some("客户表"), "中文注释: {customer:?}");

            let cols = live.describe_table("db_shop", "customer").await.expect("describe_table 失败");
            assert!(cols.len() >= 5, "列数异常: {cols:?}");
            assert!(cols.iter().any(|c| c.key == "PRI" && c.name == "id"));

            live.shutdown().await;
        }

        /// 字段级差异检测回归：只改 varchar 长度 / decimal 精度，必须逐条比出来
        /// （用户反馈"字段长度不一样没对比出来"——本测试锁定该能力）。
        /// 同版本（8.x vs 8.x）与跨版本（8.x vs 5.6）两组都验。
        #[tokio::test]
        async fn e2e_field_level_diff_detected() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let a = MySqlLive::new(pool_a, None);

            // 同版本样本：两边仅 name 长度与 price 精度不同
            let fixture = [
                "DROP DATABASE IF EXISTS `db_len_a`",
                "DROP DATABASE IF EXISTS `db_len_b`",
                "CREATE DATABASE `db_len_a` DEFAULT CHARACTER SET utf8mb4",
                "CREATE DATABASE `db_len_b` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_len_a`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(50) NOT NULL COMMENT '名字',\
                   `price` decimal(10,2) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
                "CREATE TABLE `db_len_b`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(200) NOT NULL COMMENT '名字',\
                   `price` decimal(12,4) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture {
                a.execute(sql).await.unwrap();
            }

            let s = a.snapshot_schema("db_len_a").await.unwrap();
            let t = a.snapshot_schema("db_len_b").await.unwrap();
            let items = diff_snapshots(&s, &t);
            eprintln!("同版本差异: {items:#?}");
            let name_diff = items.iter().find(|i| i.id == "col:t1:name")
                .unwrap_or_else(|| panic!("varchar(50) vs varchar(200) 没比出来！全部: {items:?}"));
            assert!(name_diff.sql.as_deref().unwrap().contains("varchar(50)"));
            let price_diff = items.iter().find(|i| i.id == "col:t1:price")
                .unwrap_or_else(|| panic!("decimal(10,2) vs decimal(12,4) 没比出来！全部: {items:?}"));
            assert!(price_diff.sql.as_deref().unwrap().contains("decimal(10,2)"));
            assert!(!items.iter().any(|i| i.id == "col:t1:id" || i.id == "col:t1:note"),
                "无差异的列不应出现: {items:?}");

            // 跨版本样本：5.6 上建同构表，仅 name 是真实长度差异 varchar(50) vs varchar(60)
            let endpoint56 = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool56 = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint56, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let l56 = MySqlLive::new(pool56, None);
            let fixture56 = [
                "DROP DATABASE IF EXISTS `db_len_c`",
                "CREATE DATABASE `db_len_c` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_len_c`.`t1` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(60) NOT NULL COMMENT '名字',\
                   `price` decimal(10,2) NOT NULL DEFAULT 0.00,\
                   `note` varchar(255) NULL,\
                   PRIMARY KEY (`id`)) ENGINE=InnoDB",
            ];
            for sql in fixture56 {
                l56.execute(sql).await.unwrap();
            }
            let t56 = l56.snapshot_schema("db_len_c").await.unwrap();
            let items_xv = diff_snapshots(&s, &t56);
            eprintln!("跨版本差异: {items_xv:#?}");
            assert_eq!(items_xv.len(), 1, "跨版本应只有 name 一项真实差异: {items_xv:?}");
            assert_eq!(items_xv[0].id, "col:t1:name");
            assert!(items_xv[0].sql.as_deref().unwrap().contains("varchar(50)"));

            // 清理
            a.execute("DROP DATABASE `db_len_a`").await.unwrap();
            a.execute("DROP DATABASE `db_len_b`").await.unwrap();
            l56.execute("DROP DATABASE `db_len_c`").await.unwrap();
            a.shutdown().await;
            l56.shutdown().await;
        }

        /// 跨版本归一化回归：同一份 DDL 在 8.4 与 5.6 上各自建好后，
        /// 对比应为零差异（整数显示宽度 int(11) vs int 等已归一化）。
        /// 5.6 侧的 db_shop 由本测试自建（幂等）。
        #[tokio::test]
        async fn e2e_cross_version_normalized() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint56 = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool56 = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint56, Some("123123"))
                .await
                .expect("连接 mysql56 失败");
            let l56 = MySqlLive::new(pool56, None);

            // 用独立库名 db_shop_xv，避免与并行的 browse 测试争用 db_shop
            let fixture = [
                "SET NAMES utf8mb4",
                "DROP DATABASE IF EXISTS `db_shop_xv`",
                "CREATE DATABASE `db_shop_xv` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `db_shop_xv`.`customer` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',\
                   `name` varchar(64) NOT NULL COMMENT '客户姓名',\
                   `phone` varchar(20) DEFAULT NULL COMMENT '手机号',\
                   `level` tinyint NOT NULL DEFAULT '1' COMMENT '等级 1普通 2VIP 3SVIP',\
                   `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',\
                   PRIMARY KEY (`id`), UNIQUE KEY `uk_phone` (`phone`)\
                 ) ENGINE=InnoDB COMMENT='客户表'",
                "CREATE TABLE `db_shop_xv`.`orders` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '订单号',\
                   `customer_id` bigint unsigned NOT NULL COMMENT '客户ID',\
                   `amount` decimal(12,2) NOT NULL DEFAULT '0.00' COMMENT '金额',\
                   `status` varchar(16) NOT NULL DEFAULT 'created' COMMENT '状态',\
                   PRIMARY KEY (`id`), KEY `idx_customer` (`customer_id`)\
                 ) ENGINE=InnoDB COMMENT='订单表'",
            ];
            for sql in fixture {
                l56.execute(sql).await.expect("5.6 建同构样本失败");
            }

            // 源：8.4 的 db_shop_xv（init-a.sql 建的）
            let endpoint_a = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
            let pool_a = mysql::open_pool(&profile("127.0.0.1", 3306, ""), &endpoint_a, Some("dbflow-a-2026"))
                .await
                .expect("连接 mysql-a 失败");
            let l8 = MySqlLive::new(pool_a, None);

            let s8 = l8.snapshot_schema("db_shop_xv").await.unwrap();
            let s56 = l56.snapshot_schema("db_shop_xv_xv").await.unwrap();
            let items = diff_snapshots(&s8, &s56);
            assert!(
                items.is_empty(),
                "8.4 vs 5.6 同构库出现假差异: {:?}",
                items.iter().map(|i| format!("{} [{}|{}]", i.id, i.source_desc.clone().unwrap_or_default(), i.target_desc.clone().unwrap_or_default())).collect::<Vec<_>>()
            );

            l56.shutdown().await;
            l8.shutdown().await;
        }

        /// MySQL 5.6 冒烟：建两个差异库 → 对比 → 部署 → 复比为空（验证旧版兼容性）
        #[tokio::test]
        async fn e2e_mysql56_compare_smoke() {
            if !enabled() {
                eprintln!("跳过（未设置 DBFLOW_E2E）");
                return;
            }
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3307 };
            let pool = mysql::open_pool(&profile("127.0.0.1", 3307, ""), &endpoint, Some("123123"))
                .await
                .expect("连接 mysql56 失败（容器没起？）");
            let live = MySqlLive::new(pool, None);

            let setup = [
                "DROP DATABASE IF EXISTS `dbflow_cmp_a`",
                "DROP DATABASE IF EXISTS `dbflow_cmp_b`",
                "CREATE DATABASE `dbflow_cmp_a` DEFAULT CHARACTER SET utf8mb4",
                "CREATE DATABASE `dbflow_cmp_b` DEFAULT CHARACTER SET utf8mb4",
                "CREATE TABLE `dbflow_cmp_a`.`t` (\
                   `id` bigint unsigned NOT NULL AUTO_INCREMENT,\
                   `name` varchar(64) NOT NULL DEFAULT '' COMMENT '名称',\
                   `flag` tinyint(1) NOT NULL DEFAULT '0',\
                   PRIMARY KEY (`id`), KEY `idx_name` (`name`)\
                 ) ENGINE=InnoDB COMMENT='测试表'",
            ];
            for sql in setup {
                live.execute(sql).await.expect("5.6 建样本失败");
            }

            let a = live.snapshot_schema("dbflow_cmp_a").await.expect("5.6 源快照");
            let b = live.snapshot_schema("dbflow_cmp_b").await.expect("5.6 目标快照");
            let items = diff_snapshots(&a, &b);
            assert_eq!(items.len(), 1, "{items:?}");
            assert_eq!(items[0].id, "tbl:t");

            live.execute(items[0].sql.as_deref().unwrap()).await.expect("5.6 建表部署失败");

            let b2 = live.snapshot_schema("dbflow_cmp_b").await.unwrap();
            assert!(diff_snapshots(&a, &b2).is_empty(), "5.6 部署后仍有差异");

            // 中文注释经 5.6 往返无损
            assert_eq!(b2.tables[0].comment.as_deref(), Some("测试表"));

            live.execute("DROP DATABASE `dbflow_cmp_a`").await.unwrap();
            live.execute("DROP DATABASE `dbflow_cmp_b`").await.unwrap();
            live.shutdown().await;
        }
    }
}
