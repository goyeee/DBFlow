use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::{Connection, Row};

use crate::config::model::{ConnectionProfile, SslMode};
use crate::error::{AppError, AppResult};

use super::{
    ColumnBrief, DatabaseBrief, LiveConnection, SchemaSnapshot, TableBrief,
};
use crate::tunnel::TunnelLease;

/// information_schema 里不展示的系统库
const SYSTEM_SCHEMAS: [&str; 4] = [
    "information_schema",
    "mysql",
    "performance_schema",
    "sys",
];

/// 连接端点：直连时是 profile 的 host:port，走隧道时是本地随机端口
pub struct ConnectEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn build_connect_options(
    profile: &ConnectionProfile,
    endpoint: &ConnectEndpoint,
    password: Option<&str>,
) -> MySqlConnectOptions {
    let mut opts = MySqlConnectOptions::new()
        .host(&endpoint.host)
        .port(endpoint.port)
        .username(&profile.user);
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = &profile.default_database {
        opts = opts.database(db);
    }
    let ssl = match profile.options.ssl_mode {
        SslMode::Disabled => MySqlSslMode::Disabled,
        SslMode::Preferred => MySqlSslMode::Preferred,
        SslMode::Required => MySqlSslMode::Required,
    };
    opts = opts.ssl_mode(ssl);
    // 默认 utf8mb4：不显式设置时驱动按 latin1 协商，中文注释会乱码
    let charset = profile
        .options
        .charset
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("utf8mb4");
    opts = opts.charset(charset);
    opts
}

fn acquire_timeout(profile: &ConnectionProfile) -> Duration {
    Duration::from_secs(profile.options.connect_timeout_secs.clamp(1, 120) as u64)
}

/// 建连接池（正式连接用）
pub async fn open_pool(
    profile: &ConnectionProfile,
    endpoint: &ConnectEndpoint,
    password: Option<&str>,
) -> AppResult<MySqlPool> {
    let opts = build_connect_options(profile, endpoint, password);
    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(acquire_timeout(profile))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// 单连接查一次版本号（测试连接用，完即拆）
pub async fn fetch_version(
    profile: &ConnectionProfile,
    endpoint: &ConnectEndpoint,
    password: Option<&str>,
) -> AppResult<String> {
    let opts = build_connect_options(profile, endpoint, password);
    let fut = sqlx::mysql::MySqlConnection::connect_with(&opts);
    let mut conn = match tokio::time::timeout(
        acquire_timeout(profile) + Duration::from_secs(2),
        fut,
    )
    .await
    {
        Ok(Ok(conn)) => conn,
        Ok(Err(e)) => return Err(AppError::from(e)),
        Err(_) => return Err(AppError::Db("连接超时，请检查网络或防火墙设置".into())),
    };
    let version: String = sqlx::query("SELECT VERSION()")
        .fetch_one(&mut conn)
        .await?
        .try_get(0)
        .map_err(|e| AppError::Db(format!("读取版本号失败: {}", e)))?;
    conn.close().await.ok();
    Ok(version)
}

/// 活动的 MySQL 会话：连接池 + 可选的隧道租约（随本结构 Drop 自动释放）
pub struct MySqlLive {
    pool: MySqlPool,
    /// 持有即保活：lease 在则隧道引用计数 +1，随 MySqlLive 一起 Drop 释放
    #[allow(dead_code)]
    pub lease: Option<TunnelLease>,
}

impl MySqlLive {
    pub fn new(pool: MySqlPool, lease: Option<TunnelLease>) -> Self {
        Self { pool, lease }
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.pool
    }
}

#[async_trait::async_trait]
impl LiveConnection for MySqlLive {
    async fn list_databases(&self) -> AppResult<Vec<DatabaseBrief>> {
        // 注意：5.6 的结果列元数据按 SELECT 原文回显（8.x 统一大写），
        // 单列查询必须按序号取值，按名字取会因大小写不匹配静默丢行
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.SCHEMATA ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut out: Vec<DatabaseBrief> = rows
            .into_iter()
            .map(|row| {
                let name: String = row.try_get(0)?;
                Ok(DatabaseBrief { name })
            })
            .collect::<Result<Vec<_>, sqlx::Error>>()?;
        out.retain(|d| !SYSTEM_SCHEMAS.contains(&d.name.as_str()));
        Ok(out)
    }

    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableBrief>> {
        let rows = sqlx::query(
            r#"
            SELECT TABLE_NAME, ENGINE, TABLE_ROWS, TABLE_COMMENT
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME
            "#,
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name: String = row.try_get("TABLE_NAME").ok()?;
                Some(TableBrief {
                    name,
                    engine: row.try_get::<Option<String>, _>("ENGINE").ok().flatten(),
                    rows_estimate: row
                        .try_get::<Option<i64>, _>("TABLE_ROWS")
                        .ok()
                        .flatten()
                        .map(|v| v.max(0) as u64),
                    comment: row
                        .try_get::<Option<String>, _>("TABLE_COMMENT")
                        .ok()
                        .flatten()
                        .filter(|c| !c.is_empty()),
                })
            })
            .collect())
    }

    async fn describe_table(&self, database: &str, table: &str) -> AppResult<Vec<ColumnBrief>> {
        let rows = sqlx::query(
            r#"
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
                   COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
            "#,
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name: String = row.try_get("COLUMN_NAME").ok()?;
                let nullable: String = row.try_get("IS_NULLABLE").ok()?;
                Some(ColumnBrief {
                    name,
                    data_type: row.try_get("COLUMN_TYPE").unwrap_or_default(),
                    nullable: nullable.eq_ignore_ascii_case("YES"),
                    key: row.try_get("COLUMN_KEY").unwrap_or_default(),
                    default: row
                        .try_get::<Option<String>, _>("COLUMN_DEFAULT")
                        .ok()
                        .flatten(),
                    extra: row.try_get("EXTRA").unwrap_or_default(),
                    comment: row
                        .try_get::<Option<String>, _>("COLUMN_COMMENT")
                        .ok()
                        .flatten()
                        .filter(|c| !c.is_empty()),
                })
            })
            .collect())
    }

    async fn snapshot_schema(&self, database: &str) -> AppResult<SchemaSnapshot> {
        use std::collections::BTreeMap;

        use super::{normalize_default, normalize_extra, ColumnDef, IndexDef, SchemaSnapshot, TableDef};

        // 表
        let table_rows = sqlx::query(
            r#"
            SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME
            "#,
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await?;

        // 列
        let column_rows = sqlx::query(
            r#"
            SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
                   COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, ORDINAL_POSITION
            "#,
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await?;

        // 索引（行粒度 = 索引的一列）
        let index_rows = sqlx::query(
            r#"
            SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
            "#,
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await?;

        let mut tables: BTreeMap<String, TableDef> = BTreeMap::new();
        for row in table_rows {
            let name: String = row.try_get("TABLE_NAME")?;
            tables.insert(
                name.clone(),
                TableDef {
                    name,
                    engine: row.try_get::<Option<String>, _>("ENGINE").ok().flatten(),
                    collation: row
                        .try_get::<Option<String>, _>("TABLE_COLLATION")
                        .ok()
                        .flatten(),
                    comment: row
                        .try_get::<Option<String>, _>("TABLE_COMMENT")
                        .ok()
                        .flatten()
                        .filter(|c| !c.is_empty()),
                    columns: Vec::new(),
                    indexes: Vec::new(),
                },
            );
        }

        for row in column_rows {
            let table: String = row.try_get("TABLE_NAME")?;
            let entry = tables.entry(table).or_default();
            let name: String = row.try_get("COLUMN_NAME")?;
            entry.columns.push(ColumnDef {
                name,
                data_type: super::normalize_data_type(&row.try_get::<String, _>("COLUMN_TYPE").unwrap_or_default()),
                nullable: row
                    .try_get::<String, _>("IS_NULLABLE")
                    .map(|v| v.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true),
                default: normalize_default(row.try_get::<Option<String>, _>("COLUMN_DEFAULT").ok().flatten()),
                extra: normalize_extra(
                    row.try_get::<Option<String>, _>("EXTRA").ok().flatten(),
                ),
                comment: row
                    .try_get::<Option<String>, _>("COLUMN_COMMENT")
                    .ok()
                    .flatten()
                    .filter(|c| !c.is_empty()),
                ordinal: row
                    .try_get::<Option<i64>, _>("ORDINAL_POSITION")
                    .ok()
                    .flatten()
                    .unwrap_or(0) as u32,
            });
        }

        // STATISTICS 按表内索引名聚合（行已按 SEQ_IN_INDEX 排序）
        let mut index_seen: BTreeMap<(String, String), IndexDef> = BTreeMap::new();
        for row in index_rows {
            let table: String = row.try_get("TABLE_NAME")?;
            let index_name: String = row.try_get("INDEX_NAME")?;
            let column: String = row.try_get("COLUMN_NAME")?;
            let key = (table.clone(), index_name.clone());
            let def = index_seen.entry(key).or_insert_with(|| IndexDef {
                name: index_name.clone(),
                columns: Vec::new(),
                unique: row
                    .try_get::<Option<i64>, _>("NON_UNIQUE")
                    .ok()
                    .flatten()
                    .map(|v| v == 0)
                    .unwrap_or(false),
                is_primary: index_name == "PRIMARY",
                index_type: row
                    .try_get::<Option<String>, _>("INDEX_TYPE")
                    .ok()
                    .flatten(),
            });
            def.columns.push(column);
        }
        for ((table, _), def) in index_seen {
            if let Some(t) = tables.get_mut(&table) {
                t.indexes.push(def);
            }
        }

        Ok(SchemaSnapshot {
            database: database.to_string(),
            tables: tables.into_values().collect(),
        })
    }

    async fn execute(&self, sql: &str) -> AppResult<()> {
        // DDL 用文本协议（raw_sql）：MySQL 5.6 不支持 PREPARE CREATE/DROP DATABASE 等语句。
        // SQL 来自自家 sqlgen（标识符/字面量均已转义）或用户明确勾选的同步语句，非外部输入；
        // async_trait 的生命周期装箱要求先拥有化。
        let owned = sql.to_owned();
        sqlx::raw_sql(sqlx::AssertSqlSafe(owned.as_str()))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn ping(&self) -> AppResult<String> {
        let version: String = sqlx::query("SELECT VERSION()")
            .fetch_one(&self.pool)
            .await?
            .try_get(0)
            .map_err(|e| AppError::Db(format!("读取版本号失败: {}", e)))?;
        Ok(version)
    }

    async fn shutdown(&self) {
        self.pool.close().await;
        // 隧道租随 MySqlLive 一起 Drop 释放（引用计数 -1，归零后延迟回收）
    }
}

/// 诊断：用用户真实保存的连接配置（connections.json + 钥匙串密码）
/// 走完整后端路径 connect → list_databases，定位"树打不开"到底断在哪。
///   DBFLOW_E2E=1 DBFLOW_DIAG_PROFILE="mysql5.6" cargo test --lib diag -- --nocapture
#[cfg(test)]
mod diag_tests {
    use super::*;

    #[tokio::test]
    async fn diag_real_profile_full_path() {
        // 手动诊断工具：只有显式指定 DBFLOW_DIAG_PROFILE 才运行。
        // 它会读真实钥匙串——测试二进制重编译后不被 ACL 信任会弹授权框并阻塞，
        // 绝不能在日常全量测试中触发。
        let profile_name = match std::env::var("DBFLOW_DIAG_PROFILE") {
            Ok(v) => v,
            Err(_) => {
                eprintln!("跳过（未设置 DBFLOW_DIAG_PROFILE）");
                return;
            }
        };
        let path = format!(
            "{}/Library/Application Support/com.dbflow.app/connections.json",
            std::env::var("HOME").unwrap_or_default()
        );
        let raw = std::fs::read_to_string(&path).expect("读 connections.json 失败");
        let cfg: serde_json::Value = serde_json::from_str(&raw).expect("connections.json 解析失败");
        let conn = cfg["connections"]
            .as_array()
            .expect("connections 数组缺失")
            .iter()
            .find(|c| c["name"].as_str() == Some(profile_name.as_str()))
            .unwrap_or_else(|| panic!("找不到名为 {profile_name} 的连接"));
        let id = uuid::Uuid::parse_str(conn["id"].as_str().expect("id 缺失")).unwrap();
        let host = conn["host"].as_str().unwrap().to_string();
        let port = conn["port"].as_u64().unwrap() as u16;
        let user = conn["user"].as_str().unwrap().to_string();
        eprintln!("== 诊断连接: {profile_name} {host}:{port} user={user} id={id}");

        // 1. 钥匙串密码
        let password = crate::secret::get(id, crate::secret::SecretKind::Db).expect("钥匙串读取失败");
        eprintln!("== 钥匙串密码: {}", if password.is_some() { "存在" } else { "不存在" });

        // 2. 与应用 connect 完全相同的路径建池
        let profile = crate::config::model::ConnectionProfile {
            id,
            name: profile_name.clone(),
            group_id: None,
            color: None,
            db: crate::config::model::DatabaseKind::MySql,
            host: host.clone(),
            port,
            user: user.clone(),
            default_database: None,
            has_password: password.is_some(),
            ssh_has_password: false,
            options: serde_json::from_value(conn["options"].clone()).unwrap_or_default(),
            ssh: None,
            created_at: 0,
            updated_at: 0,
        };
        let endpoint = ConnectEndpoint { host, port };
        match open_pool(&profile, &endpoint, password.as_deref()).await {
            Ok(pool) => {
                eprintln!("== 建池: 成功");
                let live = MySqlLive::new(pool, None);
                match live.list_databases().await {
                    Ok(dbs) => {
                        eprintln!("== list_databases: {} 个 → {:?}", dbs.len(),
                            dbs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>());
                    }
                    Err(e) => eprintln!("== list_databases 失败: {e}"),
                }
                live.shutdown().await;
            }
            Err(e) => eprintln!("== 建池失败: {e}"),
        }
    }
}

/// 端到端测试（需 docker/testenv 环境）：
///   DBFLOW_E2E=1 cargo test -p dbflow --lib e2e -- --nocapture
/// 未设置 DBFLOW_E2E 时自动跳过。
#[cfg(test)]
mod e2e_tests {
    use super::*;

    fn e2e_enabled() -> bool {
        std::env::var("DBFLOW_E2E").is_ok()
    }

    fn test_profile() -> ConnectionProfile {
        use crate::config::model::*;
        ConnectionProfile {
            id: uuid::Uuid::new_v4(),
            name: "e2e".into(),
            group_id: None,
            color: None,
            db: DatabaseKind::MySql,
            host: "127.0.0.1".into(),
            port: 3306,
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

    #[tokio::test]
    async fn e2e_mysql_direct_full_flow() {
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let profile = test_profile();
        let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
        let pool = open_pool(&profile, &endpoint, Some("dbflow-a-2026"))
            .await
            .expect("连接 mysql-a 失败");
        let live = MySqlLive::new(pool, None);

        // 字符集诊断
        {
            use sqlx::Row;
            let row: sqlx::mysql::MySqlRow = sqlx::query(
                "SELECT @@character_set_client, @@character_set_connection, @@character_set_results, HEX(TABLE_COMMENT) FROM information_schema.TABLES WHERE TABLE_SCHEMA='db_shop' AND TABLE_NAME='customer'",
            )
            .fetch_one(live.pool())
            .await
            .expect("字符集查询失败");
            eprintln!(
                "charset client={} conn={} results={} comment_hex={}",
                row.try_get::<String, _>(0).unwrap(),
                row.try_get::<String, _>(1).unwrap(),
                row.try_get::<String, _>(2).unwrap(),
                row.try_get::<String, _>(3).unwrap()
            );
        }

        let version = live.ping().await.expect("ping");
        assert!(version.starts_with('8'), "版本号异常: {version}");

        let dbs = live.list_databases().await.expect("库列表");
        let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"db_shop"), "缺少 db_shop: {names:?}");
        assert!(names.contains(&"db_log"), "缺少 db_log: {names:?}");
        assert!(!names.contains(&"mysql"), "系统库未被过滤: {names:?}");

        let tables = live.list_tables("db_shop").await.expect("表列表");
        let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert!(tnames.contains(&"customer") && tnames.contains(&"orders"), "{tnames:?}");
        let customer = tables.iter().find(|t| t.name == "customer").unwrap();
        assert_eq!(customer.comment.as_deref(), Some("客户表"));

        let cols = live.describe_table("db_shop", "customer").await.expect("列信息");
        assert!(cols.len() >= 5);
        assert!(cols.iter().any(|c| c.key == "PRI" && c.name == "id"));
        assert!(cols.iter().any(|c| c.comment.as_deref() == Some("客户姓名")));

        live.shutdown().await;
    }

    #[tokio::test]
    async fn e2e_mysql_wrong_password_friendly_error() {
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let profile = test_profile();
        let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3306 };
        let err = open_pool(&profile, &endpoint, Some("wrong-password"))
            .await
            .expect_err("错误密码不应连接成功");
        let msg = err.to_string();
        assert!(msg.contains("用户名或密码错误"), "错误文案不友好: {msg}");
    }
}
