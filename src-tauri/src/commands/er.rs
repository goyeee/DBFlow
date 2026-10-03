use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::compare::er_model::{diff_model_vs_db, ErModelTableInput, ErTableSchemaInput};
use crate::compare::sqlgen::{create_table_sql, foreign_key_ddl};
use crate::compare::DiffItem;
use crate::config::er_models::ErModelStore;
use crate::datasource::{ForeignKeyDef, Registry, TableDef};
use crate::error::{AppError, AppResult};

/// ER 图快照：表结构 + 外键（视图不进 ER 图）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErSnapshot {
    pub tables: Vec<TableDef>,
    pub foreign_keys: Vec<ForeignKeyDef>,
    pub server_version: Option<String>,
}

async fn live(
    registry: &State<'_, Registry>,
    id: Uuid,
) -> AppResult<std::sync::Arc<dyn crate::datasource::LiveConnection>> {
    registry.get(id).await.ok_or(AppError::NotFound)
}

#[tauri::command]
pub async fn get_er_snapshot(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
) -> AppResult<ErSnapshot> {
    let conn = live(&registry, connection_id).await?;
    let mut snap = conn.snapshot_tables(&database, None).await?;
    let foreign_keys = conn.list_foreign_keys(&database).await?;
    Ok(ErSnapshot {
        tables: snap.tables,
        foreign_keys,
        server_version: snap.server_version.take(),
    })
}

#[tauri::command]
pub async fn load_er_model(
    store: State<'_, ErModelStore>,
    connection_id: String,
    database: String,
) -> AppResult<Option<serde_json::Value>> {
    store.load(&connection_id, &database)
}

#[tauri::command]
pub async fn save_er_model(
    store: State<'_, ErModelStore>,
    connection_id: String,
    database: String,
    doc: serde_json::Value,
) -> AppResult<()> {
    store.save(&connection_id, &database, doc)
}

#[tauri::command]
pub async fn delete_er_model(
    store: State<'_, ErModelStore>,
    connection_id: String,
    database: String,
) -> AppResult<()> {
    store.delete(&connection_id, &database)
}

/// 导出模型文档到任意路径（前端 dialog 选好路径后调用，即协作分享的载体）
#[tauri::command]
pub async fn export_er_model(path: String, doc: serde_json::Value) -> AppResult<()> {
    let text = serde_json::to_string_pretty(&doc)
        .map_err(|e| AppError::Config(format!("序列化失败: {}", e)))?;
    std::fs::write(&path, text).map_err(|e| AppError::Config(format!("写入 {}: {}", path, e)))
}

/// 导出 DDL 到任意路径（.sql 文本）
#[tauri::command]
pub async fn export_er_sql(path: String, sql: String) -> AppResult<()> {
    std::fs::write(&path, sql).map_err(|e| AppError::Config(format!("写入 {}: {}", path, e)))
}

/// 导出 PNG 图片：前端 html-to-image 产出 data URL（base64），这里解码落盘
#[tauri::command]
pub async fn export_er_image(path: String, data_url: String) -> AppResult<()> {
    use base64::Engine as _;
    let payload = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| AppError::Config("非 PNG data URL".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::Config(format!("图片解码失败: {}", e)))?;
    std::fs::write(&path, bytes).map_err(|e| AppError::Config(format!("写入 {}: {}", path, e)))
}

/// 导出选中表的建表 DDL（+ 两端都在选中范围内的外键约束）
#[tauri::command]
pub async fn export_tables_ddl(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
    tables: Vec<String>,
) -> AppResult<String> {
    if tables.is_empty() {
        return Ok(String::new());
    }
    let conn = live(&registry, connection_id).await?;
    let snap = conn.snapshot_tables(&database, Some(&tables)).await?;
    let fks = conn.list_foreign_keys(&database).await?;
    let mut out: Vec<String> = snap
        .tables
        .iter()
        .map(|t| create_table_sql(&database, t))
        .collect();
    for fk in fks_in_scope(&tables, &fks) {
        // 仅导出两端都在选中范围内的外键，避免目标端因缺表执行失败
        out.push(foreign_key_ddl(&database, fk));
    }
    Ok(out.join("\n\n"))
}

/// ER 图上建模的「应用变更」第一步：模型 payload vs 库实时结构 → 差异清单。
/// 只比较模型涉及的表；库里其他表永不参与
#[tauri::command]
pub async fn er_diff(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
    model: Vec<ErModelTableInput>,
) -> AppResult<Vec<DiffItem>> {
    let conn = live(&registry, connection_id).await?;
    let involved: Vec<String> = model.iter().map(|t| t.name.clone()).collect();
    let snap = conn.snapshot_tables(&database, Some(&involved)).await?;
    let fks = conn.list_foreign_keys(&database).await?;
    diff_model_vs_db(&database, &model, &snap, &fks)
}

/// 表设计器底部实时 DDL 预览（不落库）。外键作为独立 ALTER 追加——
/// 外键 Tab 的编辑在预览里必须可见，否则用户以为没生效
#[tauri::command]
pub async fn preview_table_ddl(
    database: String,
    schema: ErTableSchemaInput,
) -> AppResult<String> {
    let mut out = create_table_sql(&database, &schema.table);
    for fk in &schema.foreign_keys {
        out.push_str(";\n\n");
        out.push_str(&foreign_key_ddl(&database, fk));
    }
    Ok(out)
}

/// 选中范围内、且两端表都在集合内的外键。比较统一忽略大小写：
/// 前端传来的表名可能是小写节点 id，而 FK 定义里是服务器原始大小写，
/// 大小写敏感比较会把外键语句静默漏掉
fn fks_in_scope<'a>(tables: &[String], fks: &'a [ForeignKeyDef]) -> Vec<&'a ForeignKeyDef> {
    let wanted: std::collections::HashSet<String> =
        tables.iter().map(|s| s.to_lowercase()).collect();
    fks.iter()
        .filter(|fk| {
            wanted.contains(&fk.table.to_lowercase())
                && wanted.contains(&fk.ref_table.to_lowercase())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fk(table: &str, ref_table: &str) -> ForeignKeyDef {
        ForeignKeyDef {
            name: "fk".into(),
            table: table.into(),
            columns: vec!["order_id".into()],
            ref_table: ref_table.into(),
            ref_columns: vec!["id".into()],
            on_delete: None,
            on_update: None,
        }
    }

    #[test]
    fn fk_scope_ignores_case() {
        let fks = vec![fk("Order_Items", "Orders")];
        // 前端传小写节点 id，仍应命中含大写的真实表名
        let tables = vec!["order_items".to_string(), "orders".to_string()];
        assert_eq!(fks_in_scope(&tables, &fks).len(), 1);
        // 目标表不在集合 → 不含该外键
        assert_eq!(fks_in_scope(&["order_items".to_string()], &fks).len(), 0);
    }
}
