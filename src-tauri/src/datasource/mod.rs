pub mod mysql;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::AppResult;

/// 已建立的数据库连接。所有数据库驱动都躲在这个 trait 后，
/// command 层和前端只认这组方法；新增数据库 = 新增一个实现。
#[async_trait]
pub trait LiveConnection: Send + Sync {
    async fn list_databases(&self) -> AppResult<Vec<DatabaseBrief>>;
    async fn list_tables(&self, database: &str) -> AppResult<Vec<TableBrief>>;
    async fn describe_table(&self, database: &str, table: &str) -> AppResult<Vec<ColumnBrief>>;
    /// 抓取一个库的结构快照（对比/同步用）
    #[allow(dead_code)]
    async fn snapshot_schema(&self, database: &str) -> AppResult<SchemaSnapshot> {
        self.snapshot_tables(database, None).await
    }
    /// 抓取一个库的结构快照；only_tables = Some 时只抓这些表
    async fn snapshot_tables(
        &self,
        database: &str,
        only_tables: Option<&[String]>,
    ) -> AppResult<SchemaSnapshot>;
    /// 执行一条 DDL/SQL（同步部署用）
    async fn execute(&self, sql: &str) -> AppResult<()>;
    /// 按对比键 keyset 分页拉取一块行数据（数据对比用）。
    /// select_exprs 与返回行的每一列一一对应；after_key 为上一块最后一行的键值；
    /// 返回行按键列升序。时间/小数类列已由调用方在 select_exprs 里包装成规范化文本。
    async fn fetch_rows_chunk(
        &self,
        database: &str,
        table: &str,
        select_exprs: &[String],
        key_columns: &[String],
        after_key: Option<&[Value]>,
        limit: u32,
    ) -> AppResult<Vec<Vec<Value>>>;
    /// 单连接顺序执行多条 DML：先 SET FOREIGN_KEY_CHECKS=0，全部包在一个事务里，
    /// 任一失败回滚（数据同步用；与 execute 的逐条自治语义不同）
    async fn execute_batch_tx(&self, sqls: &[String]) -> AppResult<()>;
    /// 返回服务器版本号（MySQL 为 SELECT VERSION()）
    async fn ping(&self) -> AppResult<String>;
    /// 关闭连接池并释放关联的 SSH 隧道
    async fn shutdown(&self);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBrief {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBrief {
    pub name: String,
    pub engine: Option<String>,
    pub rows_estimate: Option<u64>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnBrief {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    /// PRI / UNI / MUL / 空字符串
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
    pub comment: Option<String>,
}

// ───────────────────────── 行数据（数据对比用） ─────────────────────────

/// 归一化后的行值：两端各自拉取后可直接比较/哈希，不受版本与会话设置影响。
/// 时间与小数类列在 SELECT 里已被包装成规范化文本（见 datacmp 引擎）。
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    UInt(u64),
    Float(f64),
    /// 归一化十进制文本（去尾零、去前导零）
    Decimal(String),
    Text(String),
    Bytes(Vec<u8>),
    /// YYYY-MM-DD
    Date(String),
    /// YYYY-MM-DD HH:MM:SS[.ffffff]（会话时区已固定为 +00:00）
    DateTime(String),
    /// [H]HH:MM:SS[.ffffff]（可为负/超 24h）
    Time(String),
}

impl Value {
    /// 展示用格式化（明细界面）；Bytes 用占位符避免把大二进制塞进前端
    pub fn display(&self) -> String {
        match self {
            Value::Null => "NULL".into(),
            Value::Int(v) => v.to_string(),
            Value::UInt(v) => v.to_string(),
            Value::Float(v) => v.to_string(),
            Value::Decimal(s) | Value::Text(s) | Value::Date(s) | Value::DateTime(s) | Value::Time(s) => s.clone(),
            Value::Bytes(b) => format!("[BLOB {}]", format_size(b.len())),
        }
    }

    /// 哈希用规范化字节序列：带类型标签，避免 1(int) 与 "1"(text) 撞哈希
    pub fn hash_bytes(&self, out: &mut Vec<u8>) {
        match self {
            Value::Null => out.push(0),
            Value::Int(v) => { out.push(1); out.extend_from_slice(&v.to_le_bytes()) }
            Value::UInt(v) => { out.push(2); out.extend_from_slice(&v.to_le_bytes()) }
            Value::Float(v) => { out.push(3); out.extend_from_slice(&v.to_bits().to_le_bytes()) }
            Value::Decimal(s) => { out.push(4); out.extend_from_slice(s.as_bytes()) }
            Value::Text(s) => { out.push(5); out.extend_from_slice(s.as_bytes()) }
            Value::Bytes(b) => { out.push(6); out.extend_from_slice(&(b.len() as u64).to_le_bytes()); out.extend_from_slice(b) }
            Value::Date(s) => { out.push(7); out.extend_from_slice(s.as_bytes()) }
            Value::DateTime(s) => { out.push(8); out.extend_from_slice(s.as_bytes()) }
            Value::Time(s) => { out.push(9); out.extend_from_slice(s.as_bytes()) }
        }
        out.push(0xff); // 值间分隔，防拼接歧义
    }
}

fn format_size(n: usize) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1}MB", n as f64 / 1024.0 / 1024.0)
    } else if n >= 1024 {
        format!("{:.1}KB", n as f64 / 1024.0)
    } else {
        format!("{}B", n)
    }
}

// ───────────────────────── 结构快照（对比/同步用） ─────────────────────────

/// 一个库的结构快照：表（含列与索引）与视图定义
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SchemaSnapshot {
    pub database: String,
    pub tables: Vec<TableDef>,
    pub views: Vec<ViewDef>,
    /// 目标服务器版本（如 "8.4.11" / "5.6.40"），用于跨版本 collation 归一化
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TableDef {
    pub name: String,
    pub engine: Option<String>,
    /// 由 TABLE_COLLATION 推导字符集与排序规则
    pub collation: Option<String>,
    pub comment: Option<String>,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ColumnDef {
    pub name: String,
    /// COLUMN_TYPE 全文，如 varchar(255)、int unsigned
    pub data_type: String,
    pub nullable: bool,
    /// 归一化后的默认值（None = 无/NULL 默认）
    pub default: Option<String>,
    /// 归一化 EXTRA：auto_increment、on update current_timestamp 等
    pub extra: String,
    pub comment: Option<String>,
    pub ordinal: u32,
    /// 列级字符集（CHARACTER_SET_NAME）
    pub character_set: Option<String>,
    /// 列级排序规则（COLLATION_NAME）
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexDef {
    pub name: String,
    /// 按 SEQ_IN_INDEX 排序的列名
    pub columns: Vec<String>,
    /// 与 columns 一一对应：每列的前缀长度（None 表示完整列）
    pub sub_parts: Vec<Option<u32>>,
    /// 与 columns 一一对应：None = 默认升序，Some("DESC") = 降序（MySQL 8.0+）
    pub directions: Vec<Option<String>>,
    pub unique: bool,
    pub is_primary: bool,
    /// BTREE / HASH / FULLTEXT / SPATIAL
    pub index_type: Option<String>,
}

/// 视图定义（仅对比 SELECT 语句；definer/algorithm 等后续按需扩展）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ViewDef {
    pub name: String,
    pub definition: String,
}

/// COLUMN_DEFAULT 跨版本归一化：
/// - SQL NULL（无默认值）与字符串 "NULL"（显式 DEFAULT NULL）统一为 None
/// - CURRENT_TIMESTAMP / current_timestamp() / now() 统一为 current_timestamp
/// - 空字符串保留为 Some("")——DEFAULT '' 是有效默认值，与无默认值语义不同，
///   归一化成 None 会导致删除/新增 DEFAULT '' 检测不到差异
pub fn normalize_default(v: Option<String>) -> Option<String> {
    let v = v?;
    if v.eq_ignore_ascii_case("null") {
        return None;
    }
    let v = v.trim().to_string();
    let lower = v.to_ascii_lowercase();
    if lower == "current_timestamp()" || lower == "current_timestamp" || lower == "now()" {
        return Some("current_timestamp".to_string());
    }
    Some(v)
}

/// EXTRA 归一化：MySQL 8 的 "DEFAULT_GENERATED on update CURRENT_TIMESTAMP"
/// 与 5.6 的 "on update CURRENT_TIMESTAMP" 统一为 "on update current_timestamp"
pub fn normalize_extra(v: Option<String>) -> String {
    let v = v.unwrap_or_default().to_ascii_lowercase().replace("default_generated", " ");
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// COLUMN_TYPE 归一化：整数类型的显示宽度（已废弃、纯装饰）在 5.6 与 8.x
/// 表现不同（int(11) vs int、bigint(20) unsigned vs bigint unsigned），
/// 统一去掉，避免跨版本对比产生假差异。varchar/decimal 等有意义的宽度保留。
pub fn normalize_data_type(t: &str) -> String {
    let s = t.trim();
    if let Some(paren) = s.find('(') {
        let (head, rest) = s.split_at(paren);
        let base = head.trim();
        let is_int = matches!(
            base.to_ascii_lowercase().as_str(),
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint"
        );
        if is_int {
            if let Some(close) = rest.find(')') {
                // 去掉 (N)，保留 unsigned / zerofill 等后缀
                return format!("{}{}", base, &rest[close + 1..]);
            }
        }
    }
    s.to_string()
}

#[cfg(test)]
mod normalize_tests {
    use super::*;

    #[test]
    fn data_type_integer_width_stripped() {
        assert_eq!(normalize_data_type("int(11)"), "int");
        assert_eq!(normalize_data_type("bigint(20) unsigned"), "bigint unsigned");
        assert_eq!(normalize_data_type("tinyint(1)"), "tinyint");
        assert_eq!(normalize_data_type("smallint(5) zerofill"), "smallint zerofill");
        // 8.x 无宽度形态原样
        assert_eq!(normalize_data_type("bigint unsigned"), "bigint unsigned");
        // 有意义的宽度保留
        assert_eq!(normalize_data_type("varchar(255)"), "varchar(255)");
        assert_eq!(normalize_data_type("decimal(12,2)"), "decimal(12,2)");
        assert_eq!(normalize_data_type("int"), "int");
    }

    #[test]
    fn default_and_extra() {
        assert_eq!(
            normalize_default(Some("CURRENT_TIMESTAMP".into())).as_deref(),
            Some("current_timestamp")
        );
        assert_eq!(normalize_default(Some("current_timestamp()".into())).as_deref(), Some("current_timestamp"));
        assert_eq!(normalize_default(Some("NULL".into())), None);
        assert_eq!(normalize_default(None), None);
        // DEFAULT '' 必须与"无默认值"区分（空串是有效默认值）
        assert_eq!(normalize_default(Some("".into())).as_deref(), Some(""));
        assert_eq!(
            normalize_extra(Some("DEFAULT_GENERATED on update CURRENT_TIMESTAMP".into())),
            "on update current_timestamp"
        );
        assert_eq!(normalize_extra(Some("auto_increment".into())), "auto_increment");
    }
}

/// 已连接会话注册表：profile id → 活动连接
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<Uuid, Arc<dyn LiveConnection>>>,
}

impl Registry {
    pub async fn get(&self, id: Uuid) -> Option<Arc<dyn LiveConnection>> {
        self.inner.lock().await.get(&id).cloned()
    }

    pub async fn put(&self, id: Uuid, conn: Arc<dyn LiveConnection>) {
        self.inner.lock().await.insert(id, conn);
    }

    /// 移除并关闭
    pub async fn remove(&self, id: Uuid) {
        if let Some(conn) = self.inner.lock().await.remove(&id) {
            conn.shutdown().await;
        }
    }
}
