use tauri::State;
use uuid::Uuid;

use crate::datasource::{ColumnBrief, DatabaseBrief, Registry, TableBrief};
use crate::error::{AppError, AppResult};

async fn live(registry: &State<'_, Registry>, id: Uuid) -> AppResult<std::sync::Arc<dyn crate::datasource::LiveConnection>> {
    registry.get(id).await.ok_or(AppError::NotFound)
}

#[tauri::command]
pub async fn list_databases(
    registry: State<'_, Registry>,
    connection_id: Uuid,
) -> AppResult<Vec<DatabaseBrief>> {
    live(&registry, connection_id).await?.list_databases().await
}

#[tauri::command]
pub async fn list_tables(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
) -> AppResult<Vec<TableBrief>> {
    live(&registry, connection_id)
        .await?
        .list_tables(&database)
        .await
}

#[tauri::command]
pub async fn describe_table(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
    table: String,
) -> AppResult<Vec<ColumnBrief>> {
    live(&registry, connection_id)
        .await?
        .describe_table(&database, &table)
        .await
}
