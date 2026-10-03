//! ER 模型（图上编辑建模）与库实时结构的对比：模型 payload → DiffItem。
//! 纯函数模块：结构差异复用 diff_snapshots，外键差异独立比较，
//! 最终按 DDL 依赖排序（DROP FK → DROP TABLE → 建表/改表 → ADD FK）。

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::datasource::{ForeignKeyDef, TableDef};
use crate::compare::sqlgen::{
    add_foreign_key_clause, drop_foreign_key_ddl, foreign_key_ddl, qualified, quote_ident,
};
use crate::compare::{DiffAction, DiffItem, DiffKind};
use crate::datasource::SchemaSnapshot;
use crate::error::{AppError, AppResult};

/// 模型快照组装结果：结构快照（source 用）+ 涉及表/tombstone 集合（小写）+ 模型外键
pub struct ModelSnapshot {
    pub snapshot: SchemaSnapshot,
    pub involved: HashSet<String>,
    pub tombstones: HashSet<String>,
    pub model_fks: Vec<ForeignKeyDef>,
}

/// payload + 库实时快照 → 模型快照。payload 表名与库表忽略大小写同名时
/// 对齐为库原始大小写（diff_snapshots 按名字精确匹配，不对齐会把大小写
/// 差异误判成 DROP+CREATE）；新表不在库里，保留用户输入名。
/// 「未指定」归一化：engine/collation/列级 character_set/collation 为 None
/// 表示未指定（模型无法表达「无引擎/无字符集」），表存在于库时按库回填——
/// 否则未改这些字段的编辑会产 tblopt/列级假差异，应用后角标永远消不掉。
pub fn build_model_snapshot(
    db: &str,
    model: &[ErModelTableInput],
    live: &SchemaSnapshot,
) -> ModelSnapshot {
    let live_by_lower: HashMap<String, &TableDef> = live
        .tables
        .iter()
        .map(|t| (t.name.to_lowercase(), t))
        .collect();
    let mut tables = Vec::new();
    let mut involved = HashSet::new();
    let mut tombstones = HashSet::new();
    let mut model_fks = Vec::new();
    for t in model {
        let lower = t.name.to_lowercase();
        involved.insert(lower.clone());
        let Some(s) = &t.schema else {
            tombstones.insert(lower);
            continue;
        };
        let mut td = s.table.clone();
        if let Some(lt) = live_by_lower.get(&lower) {
            td.name = lt.name.clone();
            if td.engine.is_none() {
                td.engine = lt.engine.clone();
            }
            if td.collation.is_none() {
                td.collation = lt.collation.clone();
            }
            // 列级字符集/排序规则同名回填（新加的列不在库里，保持 None）
            for c in &mut td.columns {
                if c.character_set.is_some() && c.collation.is_some() {
                    continue;
                }
                if let Some(lc) = lt.columns.iter().find(|x| x.name.eq_ignore_ascii_case(&c.name)) {
                    if c.character_set.is_none() {
                        c.character_set = lc.character_set.clone();
                    }
                    if c.collation.is_none() {
                        c.collation = lc.collation.clone();
                    }
                }
            }
        } else {
            td.name = t.name.trim().to_string();
        }
        for fk in &s.foreign_keys {
            let mut fk = fk.clone();
            fk.table = td.name.clone();
            if let Some(orig) = live_by_lower.get(&fk.ref_table.to_lowercase()) {
                fk.ref_table = orig.name.clone();
            }
            model_fks.push(fk);
        }
        tables.push(td);
    }
    ModelSnapshot {
        snapshot: SchemaSnapshot {
            database: db.to_string(),
            tables,
            views: Vec::new(),
            server_version: live.server_version.clone(),
        },
        involved,
        tombstones,
        model_fks,
    }
}

/// 前端传来的模型表：schema=None 表示 tombstone（待删除）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErModelTableInput {
    pub name: String,
    #[serde(default)]
    pub schema: Option<ErTableSchemaInput>,
}

/// 模型表结构：TableDef 字段 + 外键（FK 属于表定义，随表走）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErTableSchemaInput {
    #[serde(flatten)]
    pub table: TableDef,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
}

/// payload 校验：空/重复表名、0 列表、空列名/重复列名、重复 FK 名、FK 列数匹配。
/// 全部忽略大小写（与 ER 前端表名比较约定一致）。
pub fn validate_model_payload(tables: &[ErModelTableInput]) -> AppResult<()> {
    let mut seen_tables = HashSet::new();
    for t in tables {
        let name = t.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("表名不能为空".into()));
        }
        if !seen_tables.insert(name.to_lowercase()) {
            return Err(AppError::Validation(format!("模型中存在重复表名「{name}」")));
        }
        let Some(s) = &t.schema else { continue };
        if s.table.columns.is_empty() {
            return Err(AppError::Validation(format!("表「{name}」至少需要一列")));
        }
        let mut col_names = HashSet::new();
        for c in &s.table.columns {
            if c.name.trim().is_empty() {
                return Err(AppError::Validation(format!("表「{name}」存在空列名")));
            }
            if !col_names.insert(c.name.trim().to_lowercase()) {
                return Err(AppError::Validation(format!(
                    "表「{name}」存在重复列名「{}」",
                    c.name
                )));
            }
        }
        let mut fk_names = HashSet::new();
        for fk in &s.foreign_keys {
            if fk.name.trim().is_empty() {
                return Err(AppError::Validation(format!("表「{name}」存在空外键名")));
            }
            if !fk_names.insert(fk.name.trim().to_lowercase()) {
                return Err(AppError::Validation(format!(
                    "表「{name}」存在重复外键名「{}」",
                    fk.name
                )));
            }
            if fk.columns.is_empty() || fk.columns.len() != fk.ref_columns.len() {
                return Err(AppError::Validation(format!(
                    "外键「{}」的列数与引用列数不匹配",
                    fk.name
                )));
            }
        }
    }
    Ok(())
}

/// FK 形态描述（UI 差异树用）
fn describe_fk(fk: &ForeignKeyDef) -> String {
    let mut s = format!(
        "{}({}) → {}({})",
        fk.table,
        fk.columns.join(","),
        fk.ref_table,
        fk.ref_columns.join(",")
    );
    if let Some(d) = &fk.on_delete {
        s.push_str(&format!(" ON DELETE {d}"));
    }
    if let Some(u) = &fk.on_update {
        s.push_str(&format!(" ON UPDATE {u}"));
    }
    s
}

fn fk_item(
    action: DiffAction,
    fk: &ForeignKeyDef,
    sql: String,
    dangerous: bool,
    source_ddl: Option<String>,
    target_ddl: Option<String>,
    source_desc: Option<String>,
    target_desc: Option<String>,
) -> DiffItem {
    DiffItem {
        id: format!("fk:{}:{}", fk.table, fk.name),
        kind: DiffKind::ForeignKey,
        action,
        table: fk.table.clone(),
        name: fk.name.clone(),
        source_desc,
        target_desc,
        sql: Some(sql),
        sql_clause: None,
        dangerous,
        source_ddl,
        target_ddl,
        // 前端「勾选删表 → 自动勾选其前置 DROP FK」联动依赖此字段
        ref_table: Some(fk.ref_table.clone()),
    }
}

/// 模型外键 vs 库外键：
/// - FK 所在表 ∈ 模型 schema 表集：按（表, 约束名）匹配，模型有库无 → ADD，
///   库有模型无 → DROP（dangerous），都有但定义不同 → 一条 ALTER DROP+ADD 重建
/// - 库 FK 引用任一 tombstone 表 → 一律 DROP（删表的必然后果；所在表可以不是模型表）
/// - 其余（非模型表且不引用 tombstone）→ 不动
pub fn diff_foreign_keys(
    db: &str,
    model_tables: &HashSet<String>,
    model_fks: &[ForeignKeyDef],
    db_fks: &[ForeignKeyDef],
    tombstones: &HashSet<String>,
) -> Vec<DiffItem> {
    let model_idx: std::collections::BTreeMap<(String, String), &ForeignKeyDef> = model_fks
        .iter()
        .map(|fk| ((fk.table.to_lowercase(), fk.name.to_lowercase()), fk))
        .collect();
    let mut handled: HashSet<(String, String)> = HashSet::new();
    let mut items = Vec::new();

    for fk in db_fks {
        let key = (fk.table.to_lowercase(), fk.name.to_lowercase());
        match model_idx.get(&key) {
            Some(m) => {
                handled.insert(key);
                if **m != *fk {
                    // 定义变化：一条 ALTER 同时 DROP 旧 + ADD 新（照索引重建模式）
                    items.push(fk_item(
                        DiffAction::Modify,
                        m,
                        format!(
                            "ALTER TABLE {} DROP FOREIGN KEY {}, {}",
                            qualified(db, &m.table),
                            quote_ident(&fk.name),
                            add_foreign_key_clause(db, m)
                        ),
                        false,
                        Some(foreign_key_ddl(db, m)),
                        Some(foreign_key_ddl(db, fk)),
                        Some(describe_fk(m)),
                        Some(describe_fk(fk)),
                    ));
                }
            }
            None => {
                let in_model_table = model_tables.contains(&fk.table.to_lowercase());
                let refs_tombstone = tombstones.contains(&fk.ref_table.to_lowercase());
                if in_model_table || refs_tombstone {
                    items.push(fk_item(
                        DiffAction::Drop,
                        fk,
                        drop_foreign_key_ddl(db, &fk.table, &fk.name),
                        true,
                        None,
                        Some(foreign_key_ddl(db, fk)),
                        None,
                        Some(describe_fk(fk)),
                    ));
                }
            }
        }
    }
    for (key, m) in &model_idx {
        if handled.contains(key) {
            continue;
        }
        items.push(fk_item(
            DiffAction::Create,
            m,
            foreign_key_ddl(db, m),
            false,
            Some(foreign_key_ddl(db, m)),
            None,
            Some(describe_fk(m)),
            None,
        ));
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str, columns: &[(&str, &str)], fks: &[(&str, &[&str], &[&str])]) -> ErModelTableInput {
        let table = TableDef {
            name: name.into(),
            columns: columns
                .iter()
                .map(|(n, dt)| crate::datasource::ColumnDef {
                    name: n.to_string(),
                    data_type: dt.to_string(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        ErModelTableInput {
            name: name.into(),
            schema: Some(ErTableSchemaInput {
                table,
                foreign_keys: fks
                    .iter()
                    .map(|(n, cols, refs)| ForeignKeyDef {
                        name: n.to_string(),
                        table: name.into(),
                        columns: cols.iter().map(|s| s.to_string()).collect(),
                        ref_table: "other".into(),
                        ref_columns: refs.iter().map(|s| s.to_string()).collect(),
                        on_delete: None,
                        on_update: None,
                    })
                    .collect(),
            }),
        }
    }

    #[test]
    fn payload_deserializes_from_frontend_camel_case_json() {
        // 前端 schema JSON（camelCase、无 ordinal）→ ErModelTableInput
        let json = r#"[{
            "name": "orders",
            "schema": {
                "name": "orders", "engine": "InnoDB", "collation": null, "comment": "订单",
                "columns": [
                    {"name":"id","dataType":"bigint unsigned","nullable":false,"default":null,
                     "extra":"auto_increment","comment":null,"characterSet":null,"collation":null}
                ],
                "indexes": [{"name":"PRIMARY","columns":["id"],"subParts":[null],
                             "directions":[null],"unique":true,"isPrimary":true,"indexType":"BTREE"}],
                "foreignKeys": [{"name":"fk_user","table":"orders","columns":["uid"],
                                  "refTable":"users","refColumns":["id"],
                                  "onDelete":"CASCADE","onUpdate":null}]
            }
        }]"#;
        let v: Vec<ErModelTableInput> = serde_json::from_str(json).unwrap();
        assert_eq!(v.len(), 1);
        let s = v[0].schema.as_ref().unwrap();
        assert_eq!(s.table.columns[0].data_type, "bigint unsigned");
        assert_eq!(s.table.columns[0].ordinal, 0); // 缺省
        assert_eq!(s.foreign_keys[0].ref_table, "users");
    }

    #[test]
    fn tombstone_has_no_schema() {
        let v: Vec<ErModelTableInput> = serde_json::from_str(r#"[{"name":"old_t"}]"#).unwrap();
        assert!(v[0].schema.is_none());
    }

    #[test]
    fn validation_rejects_bad_payloads() {
        // 空表名
        assert!(validate_model_payload(&[input("", &[("id", "int")], &[])]).is_err());
        // 重复表名（忽略大小写）
        assert!(validate_model_payload(&[
            input("t", &[("id", "int")], &[]),
            input("T", &[("id", "int")], &[]),
        ])
        .is_err());
        // 0 列
        assert!(validate_model_payload(&[input("t", &[], &[])]).is_err());
        // 重复列名（忽略大小写）
        assert!(validate_model_payload(&[input("t", &[("id", "int"), ("ID", "int")], &[])]).is_err());
        // 空列名
        assert!(validate_model_payload(&[input("t", &[(" ", "int")], &[])]).is_err());
        // FK 列数不匹配
        assert!(validate_model_payload(&[input("t", &[("a", "int"), ("b", "int")], &[("fk1", &["a"], &["x", "y"])])]).is_err());
        // FK 空列
        assert!(validate_model_payload(&[input("t", &[("a", "int")], &[("fk1", &[], &[])])]).is_err());
        // 重复 FK 名（忽略大小写）
        assert!(validate_model_payload(&[input("t", &[("a", "int"), ("b", "int")], &[
            ("fk1", &["a"], &["x"]),
            ("FK1", &["b"], &["x"]),
        ])])
        .is_err());
    }

    #[test]
    fn validation_accepts_normal_payload() {
        assert!(validate_model_payload(&[
            input("t", &[("id", "bigint"), ("uid", "bigint")], &[("fk_uid", &["uid"], &["id"])]),
        ])
        .is_ok());
        // tombstone 不校验结构
        let mut t = input("gone", &[], &[]);
        t.schema = None;
        assert!(validate_model_payload(&[t]).is_ok());
    }

    use crate::datasource::{ColumnDef, SchemaSnapshot, TableDef};

    fn fkd(name: &str, table: &str, cols: &[&str], rt: &str, rc: &[&str]) -> ForeignKeyDef {
        ForeignKeyDef {
            name: name.into(),
            table: table.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            ref_table: rt.into(),
            ref_columns: rc.iter().map(|s| s.to_string()).collect(),
            on_delete: None,
            on_update: None,
        }
    }

    fn fk_ids(items: &[crate::compare::DiffItem]) -> Vec<String> {
        items.iter().map(|i| i.id.clone()).collect()
    }

    #[test]
    fn fk_add_when_model_only() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &model_tables,
            &[fkd("fk_uid", "orders", &["uid"], "users", &["id"])],
            &[],
            &HashSet::new(),
        );
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Create);
        assert!(!items[0].dangerous);
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `db`.`orders` ADD CONSTRAINT `fk_uid` FOREIGN KEY (`uid`) REFERENCES `db`.`users` (`id`)")
        );
        assert!(items[0].source_ddl.is_some() && items[0].target_ddl.is_none());
        // FK 项带 ref_table：前端「删表 → 前置删 FK」勾选联动用它
        assert_eq!(items[0].ref_table.as_deref(), Some("users"));
    }

    #[test]
    fn fk_drop_when_model_table_edited_and_fk_removed() {
        // 模型编辑了 orders 但删掉了它的 FK → DROP（dangerous）
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &model_tables,
            &[],
            &[fkd("fk_uid", "orders", &["uid"], "users", &["id"])],
            &HashSet::new(),
        );
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Drop);
        assert!(items[0].dangerous);
        assert_eq!(
            items[0].sql.as_deref(),
            Some("ALTER TABLE `db`.`orders` DROP FOREIGN KEY `fk_uid`")
        );
    }

    #[test]
    fn fk_untouched_tables_are_ignored() {
        // FK 所在表不在模型集合、也不引用 tombstone → 完全不动（别人表的外键）
        let empty: HashSet<String> = HashSet::new();
        let items = diff_foreign_keys(
            "db",
            &empty,
            &[],
            &[fkd("fk_x", "other_tbl", &["uid"], "users", &["id"])],
            &HashSet::new(),
        );
        assert!(items.is_empty());
    }

    #[test]
    fn fk_referencing_tombstone_dropped_regardless_of_owner() {
        // 非模型表上的 FK 引用了 tombstone 表 → 也必须 DROP（否则删表必失败）
        let empty: HashSet<String> = HashSet::new();
        let tombs: HashSet<String> = ["old_ref"].iter().map(|s| s.to_string()).collect();
        let items = diff_foreign_keys(
            "db",
            &empty,
            &[],
            &[fkd("fk_o", "other_tbl", &["x"], "Old_Ref", &["id"])],
            &tombs,
        );
        assert_eq!(fk_ids(&items), vec!["fk:other_tbl:fk_o"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Drop);
        assert!(items[0].dangerous);
    }

    #[test]
    fn fk_definition_change_rebuilds_in_one_alter() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let mut m = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        m.on_delete = Some("CASCADE".into());
        let d = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        let items = diff_foreign_keys("db", &model_tables, &[m], &[d], &HashSet::new());
        assert_eq!(fk_ids(&items), vec!["fk:orders:fk_uid"]);
        assert_eq!(items[0].action, crate::compare::DiffAction::Modify);
        let sql = items[0].sql.as_deref().unwrap();
        assert!(sql.contains("DROP FOREIGN KEY `fk_uid`"), "{sql}");
        assert!(sql.contains("ADD CONSTRAINT `fk_uid` FOREIGN KEY (`uid`) REFERENCES `db`.`users` (`id`) ON DELETE CASCADE"), "{sql}");
        // 一条 ALTER
        assert!(sql.starts_with("ALTER TABLE `db`.`orders`"), "{sql}");
    }

    #[test]
    fn identical_fk_no_diff() {
        let model_tables: HashSet<String> = ["orders"].iter().map(|s| s.to_string()).collect();
        let fk = fkd("fk_uid", "orders", &["uid"], "users", &["id"]);
        let items = diff_foreign_keys("db", &model_tables, &[fk.clone()], &[fk], &HashSet::new());
        assert!(items.is_empty());
    }

    fn live(db: &str, names: &[&str]) -> SchemaSnapshot {
        SchemaSnapshot {
            database: db.into(),
            tables: names
                .iter()
                .map(|n| TableDef {
                    name: n.to_string(),
                    columns: vec![ColumnDef { name: "id".into(), data_type: "int".into(), ..Default::default() }],
                    ..Default::default()
                })
                .collect(),
            views: Vec::new(),
            server_version: Some("8.0.36".into()),
        }
    }

    fn tbl(name: &str, cols: &[(&str, &str)]) -> TableDef {
        TableDef {
            name: name.into(),
            columns: cols
                .iter()
                .map(|(n, dt)| ColumnDef { name: n.to_string(), data_type: dt.to_string(), ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn model_snapshot_aligns_table_case_to_live() {
        // payload 名小写、库原始名首字母大写 → 对齐为库大小写，且不拆成 DROP+CREATE
        let l = live("db", &["Users"]);
        let m = build_model_snapshot(
            "db",
            &[input("users", &[("id", "int"), ("name", "varchar(20)")], &[])],
            &l,
        );
        assert_eq!(m.snapshot.tables[0].name, "Users"); // 对齐库大小写
        assert!(m.involved.contains("users"));
        assert!(m.tombstones.is_empty());
        assert_eq!(m.snapshot.server_version.as_deref(), Some("8.0.36"));
        // 复用 diff_snapshots 验证不产生表级 DROP+CREATE（列差异一条）
        let items = crate::compare::diff_snapshots(
            &m.snapshot,
            &SchemaSnapshot {
                database: "db".into(),
                tables: l.tables.clone(),
                views: vec![],
                server_version: l.server_version.clone(),
            },
            &crate::compare::CompareOptions::default(),
        );
        let ops: Vec<_> = items.iter().filter(|i| i.action != crate::compare::DiffAction::Noop).collect();
        assert!(ops.iter().all(|i| i.kind == crate::compare::DiffKind::Column), "{ops:?}");
    }

    #[test]
    fn model_snapshot_separates_tombstones_and_keeps_new_names() {
        let l = live("db", &["old_t", "keep"]);
        let mut tomb = input("old_t", &[], &[]);
        tomb.schema = None;
        let new_tbl = input("brand_new", &[("id", "int")], &[]);
        let m = build_model_snapshot("db", &[tomb, new_tbl.clone()], &l);
        // tombstone 不进 source，进 involved+tombstones
        assert!(m.snapshot.tables.iter().all(|t| t.name != "old_t"));
        assert!(m.tombstones.contains("old_t"));
        // 新表不在库里 → 保留用户输入名
        assert_eq!(m.snapshot.tables[0].name, "brand_new");
        assert!(m.involved.contains("brand_new") && m.involved.contains("old_t"));
    }

    #[test]
    fn model_snapshot_collects_fks_with_case_alignment() {
        let l = live("db", &["orders", "Users"]);
        let mut src = input("orders", &[("id", "int"), ("uid", "bigint")], &[("fk_uid", &["uid"], &["id"])]);
        // input() 夹具的 ref_table 固定为 "other"，这里改成 users 以测引用表大小写对齐
        if let Some(s) = &mut src.schema {
            s.foreign_keys[0].ref_table = "users".into();
        }
        let m = build_model_snapshot("db", &[src], &l);
        assert_eq!(m.model_fks.len(), 1);
        // FK 所在表与引用表都对齐库大小写
        assert_eq!(m.model_fks[0].table, "orders");
        assert_eq!(m.model_fks[0].ref_table, "Users");
    }

    #[test]
    fn unspecified_options_backfilled_from_live() {
        // 模型 engine/collation/列级 charset 为 None = 「未指定」而非「无」：
        // 表已存在于库时按库回填，否则 diff_table 会产 tblopt 假差异、
        // cols_equal 会产逐列假 MODIFY（应用后角标永远消不掉）
        let mut lt = tbl("orders", &[("id", "int")]);
        lt.engine = Some("InnoDB".into());
        lt.collation = Some("utf8mb4_general_ci".into());
        let mut lc = crate::datasource::ColumnDef {
            name: "name".into(),
            data_type: "varchar(20)".into(),
            character_set: Some("utf8mb4".into()),
            collation: Some("utf8mb4_general_ci".into()),
            ..Default::default()
        };
        lc.ordinal = 2;
        lt.columns.push(lc);
        let l = SchemaSnapshot { database: "db".into(), tables: vec![lt], views: vec![], server_version: None };
        let model = input("orders", &[("id", "int"), ("name", "varchar(20)")], &[]);
        // 模型列未带 charset（构造器默认 None）
        let m = build_model_snapshot("db", &[model], &l);
        let t = &m.snapshot.tables[0];
        assert_eq!(t.engine.as_deref(), Some("InnoDB"));
        assert_eq!(t.collation.as_deref(), Some("utf8mb4_general_ci"));
        let name_col = t.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name_col.character_set.as_deref(), Some("utf8mb4"));
        assert_eq!(name_col.collation.as_deref(), Some("utf8mb4_general_ci"));
        // 回填后与库完全一致 → 无 tblopt/列差异
        let items = crate::compare::diff_snapshots(
            &m.snapshot,
            &SchemaSnapshot { database: "db".into(), tables: l.tables.clone(), views: vec![], server_version: None },
            &crate::compare::CompareOptions::default(),
        );
        assert!(
            items.iter().all(|i| i.action == crate::compare::DiffAction::Noop),
            "未指定字段回填后不应有差异: {items:?}"
        );
        // 新表（不在库里）不回填：None 保留，CREATE 走服务器默认
        let m2 = build_model_snapshot("db", &[input("brand_new", &[("id", "int")], &[])], &l);
        assert_eq!(m2.snapshot.tables[0].engine, None);
    }
}
