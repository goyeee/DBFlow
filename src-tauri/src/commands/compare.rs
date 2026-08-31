use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::compare::{CompareOptions, DiffItem};
use crate::datasource::{LiveConnection, Registry, SchemaSnapshot};
use crate::error::{AppError, AppResult};

/// 多目标对比的单个目标规格。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareTargetSpec {
    pub key: String,
    pub connection_id: Uuid,
    pub database: String,
}

/// 单个目标对比失败的精简错误信息（cloneable，避免 AppError 含 io::Error 不可 clone）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<&AppError> for TargetError {
    fn from(e: &AppError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
            detail: e.detail(),
        }
    }
}

/// 单个目标的对比结果：成功时 `items` 非空；失败时 `error` 非空。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetReport {
    pub key: String,
    pub connection_id: Uuid,
    pub database: String,
    pub items: Vec<DiffItem>,
    pub error: Option<TargetError>,
}

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
    tables: Option<Vec<String>>,
    options: Option<CompareOptions>,
) -> AppResult<Vec<DiffItem>> {
    let src_conn = registry
        .get(source_connection_id)
        .await
        .ok_or(AppError::NotFound)?;
    let tgt_conn = registry
        .get(target_connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    let opts = options.unwrap_or_else(CompareOptions::default_for_command);

    let _ = app.emit("compare-progress", "fetch_source");
    let source = src_conn.snapshot_tables(&source_database, tables.as_deref()).await?;
    let _ = app.emit("compare-progress", "fetch_target");
    let target = tgt_conn.snapshot_tables(&target_database, tables.as_deref()).await?;
    let _ = app.emit("compare-progress", "diff");
    Ok(post_process_items(crate::compare::diff_snapshots(&source, &target, &opts)))
}

/// 一源 → 多目标并行对比。
/// 源端失败时整个命令失败；单个目标失败仅写入该目标 report.error，其他目标继续。
#[tauri::command]
pub async fn compare_schema_multi(
    registry: State<'_, Registry>,
    app: AppHandle,
    source_connection_id: Uuid,
    source_database: String,
    tables: Option<Vec<String>>,
    targets: Vec<CompareTargetSpec>,
    options: Option<CompareOptions>,
) -> AppResult<Vec<TargetReport>> {
    if targets.is_empty() {
        return Err(AppError::Validation("请至少选择一个目标".into()));
    }

    let src_conn = registry
        .get(source_connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    let opts = Arc::new(options.unwrap_or_else(CompareOptions::default_for_command));

    let _ = app.emit("compare-progress", "fetch_source");
    let source = Arc::new(src_conn.snapshot_tables(&source_database, tables.as_deref()).await?);

    let total = targets.len();
    let mut set = JoinSet::new();

    for (index, target) in targets.into_iter().enumerate() {
        let key = target.key.clone();
        let conn = registry.get(target.connection_id).await;
        let app = app.clone();
        let source = Arc::clone(&source);
        let tables = tables.clone();
        let opts = Arc::clone(&opts);

        set.spawn(async move {
            let result = compare_one_target(
                key,
                conn,
                &app,
                index,
                total,
                &source,
                tables.as_deref(),
                target,
                &opts,
            )
            .await;
            // 进度：该目标完成（无论成功失败）
            let _ = app.emit(
                "compare-multi-progress",
                serde_json::json!({
                    "index": index,
                    "total": total,
                    "phase": "done",
                    "database": result.database,
                }),
            );
            result
        });
    }

    let mut reports = Vec::with_capacity(total);
    while let Some(res) = set.join_next().await {
        // JoinSet 里的 panic 会被包装成 Err；这里转成内部错误，避免一个目标 panic 拖垮整体
        let report = match res {
            Ok(r) => r,
            Err(e) => TargetReport {
                key: String::new(),
                connection_id: Uuid::nil(),
                database: "unknown".into(),
                items: vec![],
                error: Some(TargetError::from(
                    &AppError::Internal(format!("任务异常: {e}"))
                )),
            },
        };
        reports.push(report);
    }

    Ok(reports)
}

async fn compare_one_target(
    key: String,
    conn: Option<Arc<dyn LiveConnection>>,
    app: &AppHandle,
    index: usize,
    total: usize,
    source: &SchemaSnapshot,
    tables: Option<&[String]>,
    spec: CompareTargetSpec,
    options: &CompareOptions,
) -> TargetReport {
    let emit_progress = |phase: &str| {
        let _ = app.emit(
            "compare-multi-progress",
            serde_json::json!({
                "index": index,
                "total": total,
                "phase": phase,
                "database": &spec.database,
            }),
        );
    };

    emit_progress("fetch_target");
    let target = match conn {
        Some(conn) => match conn.snapshot_tables(&spec.database, tables).await {
            Ok(snap) => snap,
            Err(e) => {
                return TargetReport {
                    key,
                    connection_id: spec.connection_id,
                    database: spec.database,
                    items: vec![],
                    error: Some(TargetError::from(&e)),
                }
            }
        },
        None => {
            return TargetReport {
                key,
                connection_id: spec.connection_id,
                database: spec.database,
                items: vec![],
                error: Some(TargetError::from(&AppError::NotFound)),
            }
        }
    };

    emit_progress("diff");
    let items = post_process_items(crate::compare::diff_snapshots(source, &target, options));

    TargetReport {
        key,
        connection_id: spec.connection_id,
        database: spec.database,
        items,
        error: None,
    }
}

/// 与现有单目标逻辑保持一致的后处理：过滤表选项差异、排序。
fn post_process_items(mut items: Vec<DiffItem>) -> Vec<DiffItem> {
    items.retain(|i| !i.id.starts_with("tblopt:"));
    items.sort_by(|a, b| {
        if a.table == b.table {
            a.id.cmp(&b.id)
        } else {
            a.table.cmp(&b.table)
        }
    });
    items
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
