use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::{Column, Connection, Row, TypeInfo};

use crate::config::model::{ConnectionProfile, SslMode};
use crate::error::{AppError, AppResult};

use super::{
    ColumnBrief, DatabaseBrief, LiveConnection, SchemaSnapshot, TableBrief, Value,
    ViewDef,
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
        // 固定会话时区：TIMESTAMP 按会话时区回显，两端时区不同会产生假差异
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::raw_sql(sqlx::AssertSqlSafe("SET time_zone = '+00:00'"))
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
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

    #[allow(dead_code)]
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

    async fn snapshot_tables(
        &self,
        database: &str,
        only_tables: Option<&[String]>,
    ) -> AppResult<SchemaSnapshot> {
        use std::collections::BTreeMap;

        use super::{normalize_default, normalize_extra, ColumnDef, IndexDef, SchemaSnapshot, TableDef};

        // 防御性：空过滤视为无过滤
        let only_tables = only_tables.filter(|ts| !ts.is_empty());

        // 表
        let mut table_qb = sqlx::QueryBuilder::new(
            "SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ",
        );
        table_qb.push_bind(database);
        table_qb.push(" AND TABLE_TYPE = 'BASE TABLE'");
        if let Some(ts) = only_tables {
            table_qb.push(" AND TABLE_NAME IN (");
            let mut sep = table_qb.separated(", ");
            for t in ts {
                sep.push_bind(t);
            }
            table_qb.push(")");
        }
        table_qb.push(" ORDER BY TABLE_NAME");
        let table_rows = table_qb.build().fetch_all(&self.pool).await?;

        // 列
        let mut column_qb = sqlx::QueryBuilder::new(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, \
                   COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION, \
                   CHARACTER_SET_NAME, COLLATION_NAME \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ",
        );
        column_qb.push_bind(database);
        if let Some(ts) = only_tables {
            column_qb.push(" AND TABLE_NAME IN (");
            let mut sep = column_qb.separated(", ");
            for t in ts {
                sep.push_bind(t);
            }
            column_qb.push(")");
        }
        column_qb.push(" ORDER BY TABLE_NAME, ORDINAL_POSITION");
        let column_rows = column_qb.build().fetch_all(&self.pool).await?;

        // 索引（行粒度 = 索引的一列）
        let mut index_qb = sqlx::QueryBuilder::new(
            "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, \
                   SUB_PART, COLLATION \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = ",
        );
        index_qb.push_bind(database);
        if let Some(ts) = only_tables {
            index_qb.push(" AND TABLE_NAME IN (");
            let mut sep = index_qb.separated(", ");
            for t in ts {
                sep.push_bind(t);
            }
            index_qb.push(")");
        }
        index_qb.push(" ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX");
        let index_rows = index_qb.build().fetch_all(&self.pool).await?;

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

        // 列只挂到真实表上（COLUMNS 会包含视图的列，视图为幻影表则跳过）。
        // ordinal 不信任 try_get 的类型转换（bigint unsigned → i64 在部分版本/驱动
        // 组合下会失败兜底成 0，导致位置对比下溢 panic）——查询已按
        // TABLE_NAME, ORDINAL_POSITION 排序，直接用表内行号。
        let mut ordinal_counters: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        for row in column_rows {
            let table: String = row.try_get("TABLE_NAME")?;
            let Some(entry) = tables.get_mut(&table) else {
                continue;
            };
            let ordinal = {
                let c = ordinal_counters.entry(table).or_insert(0);
                *c += 1;
                *c
            };
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
                ordinal,
                character_set: row
                    .try_get::<Option<String>, _>("CHARACTER_SET_NAME")
                    .ok()
                    .flatten()
                    .filter(|c| !c.is_empty()),
                collation: row
                    .try_get::<Option<String>, _>("COLLATION_NAME")
                    .ok()
                    .flatten()
                    .filter(|c| !c.is_empty()),
            });
        }

        // STATISTICS 按表内索引名聚合（行已按 SEQ_IN_INDEX 排序）
        let mut index_seen: BTreeMap<(String, String), IndexDef> = BTreeMap::new();
        for row in index_rows {
            let table: String = row.try_get("TABLE_NAME")?;
            let index_name: String = row.try_get("INDEX_NAME")?;
            let column: String = row.try_get("COLUMN_NAME")?;
            let sub_part: Option<u32> = row
                .try_get::<Option<i64>, _>("SUB_PART")
                .ok()
                .flatten()
                .and_then(|v| if v > 0 { Some(v as u32) } else { None });
            let direction: Option<String> = row
                .try_get::<Option<String>, _>("COLLATION")
                .ok()
                .flatten()
                .filter(|c| c.eq_ignore_ascii_case("D"))
                .map(|_| "DESC".to_string());
            let key = (table.clone(), index_name.clone());
            let def = index_seen.entry(key).or_insert_with(|| IndexDef {
                name: index_name.clone(),
                columns: Vec::new(),
                sub_parts: Vec::new(),
                directions: Vec::new(),
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
            def.sub_parts.push(sub_part);
            def.directions.push(direction);
        }
        for ((table, _), def) in index_seen {
            if let Some(t) = tables.get_mut(&table) {
                t.indexes.push(def);
            }
        }

        // 视图：整库快照时才抓取；按表范围同步时暂不涉及视图，避免误 DROP
        let mut views: Vec<ViewDef> = Vec::new();
        if only_tables.is_none() {
            let view_rows = sqlx::query(
                "SELECT TABLE_NAME, VIEW_DEFINITION \
                 FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = ? \
                 ORDER BY TABLE_NAME",
            )
            .bind(database)
            .fetch_all(&self.pool)
            .await?;
            for row in view_rows {
                views.push(ViewDef {
                    name: row.try_get("TABLE_NAME")?,
                    definition: row
                        .try_get::<Option<String>, _>("VIEW_DEFINITION")
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                });
            }
        }

        // 服务器版本：跨版本对比时把 0900 系 collation 归一化为低版本等价
        let server_version: Option<String> =
            sqlx::query_scalar("SELECT VERSION()").fetch_one(&self.pool).await.ok();

        Ok(SchemaSnapshot {
            database: database.to_string(),
            tables: tables.into_values().collect(),
            views,
            server_version,
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

    async fn fetch_rows_chunk(
        &self,
        database: &str,
        table: &str,
        select_exprs: &[String],
        key_columns: &[String],
        after_key: Option<&[Value]>,
        limit: u32,
    ) -> AppResult<Vec<Vec<Value>>> {
        let mut sql = format!(
            "SELECT {} FROM {}.{}",
            select_exprs.join(", "),
            quote_ident(database),
            quote_ident(table),
        );
        if after_key.is_some() {
            if key_columns.len() == 1 {
                sql.push_str(&format!(" WHERE {} > ?", quote_ident(&key_columns[0])));
            } else {
                // 多列键用行构造器做元组比较：(a,b) > (?,?)
                let cols = key_columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(",");
                let marks = vec!["?"; key_columns.len()].join(",");
                sql.push_str(&format!(" WHERE ({cols}) > ({marks})"));
            }
        }
        let order = key_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" ORDER BY {order} LIMIT {limit}"));

        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        if let Some(key) = after_key {
            for v in key {
                q = bind_value(q, v);
            }
        }
        let rows = q.fetch_all(&self.pool).await?;
        rows.iter().map(decode_row).collect()
    }

    async fn execute_batch_tx(&self, sqls: &[String]) -> AppResult<()> {
        let mut conn = self.pool.acquire().await?;
        run_dml(&mut conn, "SET FOREIGN_KEY_CHECKS=0").await?;
        run_dml(&mut conn, "START TRANSACTION").await?;
        for sql in sqls {
            if let Err(e) = run_dml(&mut conn, sql).await {
                let _ = run_dml(&mut conn, "ROLLBACK").await;
                return Err(e);
            }
        }
        run_dml(&mut conn, "COMMIT").await?;
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

// ───────────────────────── 行数据拉取辅助 ─────────────────────────

/// 事务内执行一条 DML（raw_sql 文本协议；SQL 为后端生成，值已转义）
async fn run_dml(conn: &mut sqlx::mysql::MySqlConnection, sql: &str) -> AppResult<()> {
    let owned = sql.to_owned();
    sqlx::raw_sql(sqlx::AssertSqlSafe(owned.as_str()))
        .execute(conn)
        .await?;
    Ok(())
}

fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// keyset 分页的键值绑定（键列不含 NULL：主键/全 NOT NULL 唯一索引）
fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match v {
        Value::Null => q.bind(Option::<String>::None),
        Value::Int(x) => q.bind(*x),
        Value::UInt(x) => q.bind(*x),
        Value::Float(x) => q.bind(*x),
        // 时间/小数键以规范化文本绑定，MySQL 与列比较时自动强制转换，序保持一致
        Value::Decimal(s) | Value::Text(s) | Value::Date(s) | Value::DateTime(s) | Value::Time(s) => {
            q.bind(s.clone())
        }
        Value::Bytes(b) => q.bind(b.clone()),
    }
}

/// 把一行按结果集列类型解码为 Value。
/// 时间/小数/BIT/JSON 列已在 SELECT 里被包装成文本/无符号整数（见 datacmp 引擎），
/// 所以这里只需处理整数、浮点、二进制与文本四大类。
fn decode_row(row: &sqlx::mysql::MySqlRow) -> AppResult<Vec<Value>> {
    let n = row.columns().len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let raw = row.try_get_raw(i).map_err(AppError::from)?;
        if sqlx::ValueRef::is_null(&raw) {
            out.push(Value::Null);
            continue;
        }
        let tname = row.columns()[i].type_info().name().to_ascii_uppercase();
        let base = tname
            .split(|c: char| c == ' ' || c == '(')
            .next()
            .unwrap_or("");
        let unsigned = tname.contains("UNSIGNED");
        let v = match base {
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
                if unsigned {
                    Value::UInt(row.try_get::<u64, _>(i)?)
                } else {
                    Value::Int(row.try_get::<i64, _>(i)?)
                }
            }
            "FLOAT" => Value::Float(row.try_get::<f32, _>(i)? as f64),
            "DOUBLE" | "REAL" => Value::Float(row.try_get::<f64, _>(i)?),
            // BOOLEAN 即 tinyint(1)，sqlx 协议类型名报作 BOOLEAN，不落在 TINYINT 分支
            "BOOLEAN" | "BOOL" => match row.try_get::<i8, _>(i) {
                Ok(v) => Value::Int(v as i64),
                // 无符号 tinyint(1) 可能超出 i8，退回 u8
                Err(_) => Value::UInt(row.try_get::<u8, _>(i)? as u64),
            },
            "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB"
            | "GEOMETRY" | "POINT" | "LINESTRING" | "POLYGON" | "MULTIPOINT"
            | "MULTILINESTRING" | "MULTIPOLYGON" | "GEOMETRYCOLLECTION" => {
                Value::Bytes(row.try_get::<Vec<u8>, _>(i)?)
            }
            // VARCHAR/TEXT/ENUM/SET 及 DATE_FORMAT/CAST 包装产物一律按文本
            _ => Value::Text(row.try_get::<String, _>(i)?),
        };
        out.push(v);
    }
    Ok(out)
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
            remember_password: false,
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
            port: 3308,
            user: "root".into(),
            default_database: None,
            has_password: true,
            ssh_has_password: false,
            remember_password: false,
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
        let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3308 };
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
        let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port: 3308 };
        let err = open_pool(&profile, &endpoint, Some("wrong-password"))
            .await
            .expect_err("错误密码不应连接成功");
        let msg = err.to_string();
        assert!(msg.contains("用户名或密码错误"), "错误文案不友好: {msg}");
    }

    #[tokio::test]
    async fn e2e_decode_tinyint1_boolean() {
        // 回归：BOOLEAN（tinyint(1)）列在 sqlx 协议层类型名为 BOOLEAN，
        // 曾掉进 decode_row 的 String 回退导致 8.4/5.6 数据对比整体报错。
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        for (port, password) in [(3308u16, "dbflow-a-2026"), (3307u16, "123123")] {
            let profile = test_profile();
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port };
            let pool = open_pool(&profile, &endpoint, Some(password))
                .await
                .unwrap_or_else(|e| panic!("port {port} 连接失败: {e}"));
            let live = MySqlLive::new(pool, None);
            let rows = live
                .fetch_rows_chunk(
                    "cmp_demo",
                    "t_types",
                    &["id".into(), "flag".into()],
                    &["id".into()],
                    None,
                    100,
                )
                .await
                .unwrap_or_else(|e| panic!("port {port} 解码 t_types 失败: {e}"));
            assert_eq!(rows.len(), 5, "port {port}");
            for r in &rows {
                assert!(
                    matches!(r[1], Value::Int(_) | Value::UInt(_) | Value::Null),
                    "port {port}: flag 应为整数/NULL，实际 {:?}",
                    r[1]
                );
            }
            eprintln!("port {port} BOOLEAN 解码 OK: {:?}", rows.iter().map(|r| r[1].display()).collect::<Vec<_>>());
            live.shutdown().await;
        }
    }

    #[tokio::test]
    async fn e2e_diff_cmp_schema_dump() {
        // 排查工具：打印 cmp_schema 3306→3307 结构差异全量清单
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let mut lives = Vec::new();
        for (port, password) in [(3308u16, "dbflow-a-2026"), (3307u16, "123123")] {
            let profile = test_profile();
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port };
            let pool = open_pool(&profile, &endpoint, Some(password)).await.expect("连接失败");
            let live = MySqlLive::new(pool, None);
            lives.push(live);
        }
        let src = lives[0].snapshot_tables("cmp_schema", None).await.expect("源快照");
        let tgt = lives[1].snapshot_tables("cmp_schema", None).await.expect("目标快照");
        let items = crate::compare::diff_snapshots(&src, &tgt, &crate::compare::CompareOptions::default_for_command());
        eprintln!("== 共 {} 个差异项 ==", items.len());
        for it in &items {
            eprintln!(
                "[{:?}] id={} sql={}",
                it.action,
                it.id,
                it.sql.as_deref().unwrap_or("(无 SQL)")
            );
        }
        for l in &lives {
            l.shutdown().await;
        }
    }

    #[tokio::test]
    async fn e2e_rows_preview_dump() {
        // 排查工具：打印 cmp_demo 各表行级预览的动作分布（含 equal 行）
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let mut lives: Vec<std::sync::Arc<dyn LiveConnection>> = Vec::new();
        for (port, password) in [(3308u16, "dbflow-a-2026"), (3307u16, "123123")] {
            let profile = test_profile();
            let endpoint = ConnectEndpoint { host: "127.0.0.1".into(), port };
            let pool = open_pool(&profile, &endpoint, Some(password)).await.expect("连接失败");
            lives.push(std::sync::Arc::new(MySqlLive::new(pool, None)));
        }
        for table in ["t_mixed_small", "t_types", "t_equal_big"] {
            let preview = crate::datacmp::rows_preview(
                &lives[0], &lives[1], "cmp_demo", "cmp_demo", table, 20000,
            )
            .await
            .unwrap_or_else(|e| panic!("{table}: {e}"));
            let mut n = std::collections::BTreeMap::new();
            for r in &preview.rows {
                *n.entry(format!("{:?}", r.action)).or_insert(0u64) += 1;
            }
            eprintln!("{table}: 共 {} 行, 分布 {:?}, truncated={}", preview.rows.len(), n, preview.truncated);
        }
        for l in &lives {
            l.shutdown().await;
        }
    }
}
