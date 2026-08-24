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
    async fn snapshot_schema(&self, database: &str) -> AppResult<SchemaSnapshot>;
    /// 执行一条 DDL/SQL（同步部署用）
    async fn execute(&self, sql: &str) -> AppResult<()>;
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

// ───────────────────────── 结构快照（对比/同步用） ─────────────────────────

/// 一个库的结构快照：表（含列与索引）定义，按表名排序
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SchemaSnapshot {
    pub database: String,
    pub tables: Vec<TableDef>,
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
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct IndexDef {
    pub name: String,
    /// 按 SEQ_IN_INDEX 排序的列名
    pub columns: Vec<String>,
    pub unique: bool,
    pub is_primary: bool,
    /// BTREE / HASH / FULLTEXT / SPATIAL
    pub index_type: Option<String>,
}

/// COLUMN_DEFAULT 跨版本归一化：
/// - 显式 DEFAULT NULL 与无默认（两版本呈现不一致）统一为 None
/// - CURRENT_TIMESTAMP / current_timestamp() / now() 统一为 current_timestamp
/// - 去除首尾空白；空串视为 None
pub fn normalize_default(v: Option<String>) -> Option<String> {
    let v = v?.trim().to_string();
    if v.is_empty() || v.eq_ignore_ascii_case("null") {
        return None;
    }
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
