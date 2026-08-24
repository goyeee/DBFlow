use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::compare::DiffItem;
use crate::datasource::Registry;
use crate::error::{AppError, AppResult};

/// 双端抓快照 → 差异清单（每项内嵌目标端 SQL，前端勾选后原样提交执行）
/// 过程中通过 compare-progress 事件推送阶段（前端进度弹层用）
#[tauri::command]
pub async fn compare_schema(
    registry: State<'_, Registry>,
    app: AppHandle,
    source_connection_id: Uuid,
    source_database: String,
    target_connection_id: Uuid,
    target_database: String,
) -> AppResult<Vec<DiffItem>> {
    let src_conn = registry
        .get(source_connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    let tgt_conn = registry
        .get(target_connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    let _ = app.emit("compare-progress", "fetch_source");
    let source = src_conn.snapshot_schema(&source_database).await?;
    let _ = app.emit("compare-progress", "fetch_target");
    let target = tgt_conn.snapshot_schema(&target_database).await?;
    let _ = app.emit("compare-progress", "diff");
    Ok(crate::compare::diff_snapshots(&source, &target))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub sql: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// 逐条执行选中的同步 SQL。
/// MySQL DDL 隐式提交无法回滚，故不包事务；单条失败继续，全部结果返回。
#[tauri::command]
pub async fn apply_sync(
    registry: State<'_, Registry>,
    target_connection_id: Uuid,
    sqls: Vec<String>,
) -> AppResult<Vec<ApplyResult>> {
    let conn = registry
        .get(target_connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    let mut results = Vec::with_capacity(sqls.len());
    for sql in sqls {
        let r = match conn.execute(&sql).await {
            Ok(()) => ApplyResult { sql, ok: true, error: None },
            Err(e) => ApplyResult { sql, ok: false, error: Some(e.to_string()) },
        };
        results.push(r);
    }
    Ok(results)
}
