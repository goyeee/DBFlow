//! 数据对比与同步命令：一源 → 多目标并行行级对比、明细按需拉取、按表事务同步。
//! 结构与 compare.rs（结构同步）对称，复用其 CompareTargetSpec / TargetError。
use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::datasource::{LiveConnection, Registry, Value};
use crate::datacmp::{self, DataCompareOptions, RowAction, TableDataDiff, TableDataInternal};
use crate::error::{AppError, AppResult};

use super::compare::{CompareTargetSpec, TargetError};

/// 对比报告缓存：reportId → 单目标完整结果（含行级真实值，供明细拉取与 SQL 生成）。
/// 同一 target key 重新对比时替换旧缓存。
#[derive(Default)]
pub struct DataCompareCache {
    inner: tokio::sync::Mutex<HashMap<String, CachedTargetReport>>,
}

struct CachedTargetReport {
    key: String,
    database: String,
    tables: Vec<TableDataInternal>,
    /// 行级预览需要重新拉两端数据：留存连接与源库名
    src_conn: Option<Arc<dyn LiveConnection>>,
    tgt_conn: Option<Arc<dyn LiveConnection>>,
    src_database: String,
}

/// 单目标数据对比结果（tables 为摘要，行明细走 get_table_diff_detail 按需拉取）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataTargetReport {
    pub report_id: String,
    pub key: String,
    pub connection_id: Uuid,
    pub database: String,
    pub tables: Vec<TableDataDiff>,
    pub error: Option<TargetError>,
}

/// 同步勾选粒度：表 × 类别；行级取消勾选的键放 excludeKeys（格式化主键串）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSelection {
    pub table: String,
    pub action: RowAction,
    #[serde(default)]
    pub exclude_keys: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncStatement {
    pub table: String,
    pub action: RowAction,
    pub sql: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableApplyResult {
    pub table: String,
    pub ok: bool,
    pub applied_count: usize,
    pub error: Option<String>,
}

/// 表的可对比性（选择表步骤置灰无主键表用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableKeyInfo {
    pub name: String,
    /// 可用对比键；None = 无主键/全 NOT NULL 唯一索引（不可数据对比）
    pub key_columns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

/// 列出源库各表的对比键（选择表时用，复用结构快照）
#[tauri::command]
pub async fn list_table_keys(
    registry: State<'_, Registry>,
    connection_id: Uuid,
    database: String,
) -> AppResult<Vec<TableKeyInfo>> {
    let conn = registry.get(connection_id).await.ok_or(AppError::NotFound)?;
    let snap = conn.snapshot_tables(&database, None).await?;
    Ok(snap
        .tables
        .iter()
        .map(|t| match datacmp::choose_key(t) {
            Ok((keys, _)) => TableKeyInfo {
                name: t.name.clone(),
                key_columns: Some(keys),
                skip_reason: None,
            },
            Err(reason) => TableKeyInfo {
                name: t.name.clone(),
                key_columns: None,
                skip_reason: Some(reason),
            },
        })
        .collect())
}

/// 一源 → 多目标并行数据对比。
/// 源端失败时整个命令失败；单个目标失败仅写入该目标 report.error，其他目标继续。
#[tauri::command]
pub async fn compare_data_multi(
    registry: State<'_, Registry>,
    cache: State<'_, DataCompareCache>,
    app: AppHandle,
    source_connection_id: Uuid,
    source_database: String,
    tables: Vec<String>,
    targets: Vec<CompareTargetSpec>,
    options: Option<DataCompareOptions>,
) -> AppResult<Vec<DataTargetReport>> {
    if targets.is_empty() {
        return Err(AppError::Validation("请至少选择一个目标".into()));
    }
    if tables.is_empty() {
        return Err(AppError::Validation("请至少选择一张表".into()));
    }

    let src_conn = registry
        .get(source_connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    let opts = Arc::new(options.unwrap_or_default());

    emit_progress(&app, 0, targets.len(), &source_database, None, "fetch_source", 0);
    let source_snap = Arc::new(
        src_conn
            .snapshot_tables(&source_database, Some(&tables))
            .await?,
    );

    let total = targets.len();
    let mut set = JoinSet::new();

    for (index, target) in targets.into_iter().enumerate() {
        let conn = registry.get(target.connection_id).await;
        let app = app.clone();
        let source_snap = Arc::clone(&source_snap);
        let src_conn = Arc::clone(&src_conn);
        let opts = Arc::clone(&opts);
        let tables = tables.clone();
        let source_database = source_database.clone();

        set.spawn(async move {
            let report = compare_one_target(
                &app,
                index,
                total,
                &src_conn,
                &source_database,
                &source_snap,
                conn,
                target,
                &tables,
                &opts,
            )
            .await;
            emit_progress(&app, index, total, &report.0.database, None, "done", 0);
            report
        });
    }

    let mut reports = Vec::with_capacity(total);
    let mut cached: Vec<(String, CachedTargetReport)> = Vec::new();
    while let Some(res) = set.join_next().await {
        match res {
            Ok((report, cache_entry)) => {
                if let (id, Some(entry)) = (report.report_id.clone(), cache_entry) {
                    cached.push((id, entry));
                }
                reports.push(report);
            }
            Err(e) => reports.push(DataTargetReport {
                report_id: String::new(),
                key: String::new(),
                connection_id: Uuid::nil(),
                database: "unknown".into(),
                tables: vec![],
                error: Some(TargetError::from(&AppError::Internal(format!(
                    "任务异常: {e}"
                )))),
            }),
        }
    }

    // 写入缓存：同 target key 的旧报告一并失效
    {
        let keys: Vec<&str> = cached.iter().map(|(_, c)| c.key.as_str()).collect();
        let mut guard = cache.inner.lock().await;
        guard.retain(|_, v| !keys.contains(&v.key.as_str()));
        for (id, entry) in cached {
            guard.insert(id, entry);
        }
    }

    Ok(reports)
}

#[allow(clippy::too_many_arguments)]
async fn compare_one_target(
    app: &AppHandle,
    index: usize,
    total: usize,
    src_conn: &Arc<dyn LiveConnection>,
    source_database: &str,
    source_snap: &crate::datasource::SchemaSnapshot,
    conn: Option<Arc<dyn LiveConnection>>,
    spec: CompareTargetSpec,
    tables: &[String],
    opts: &DataCompareOptions,
) -> (DataTargetReport, Option<CachedTargetReport>) {
    let fail = |e: TargetError| {
        (
            DataTargetReport {
                report_id: String::new(),
                key: spec.key.clone(),
                connection_id: spec.connection_id,
                database: spec.database.clone(),
                tables: vec![],
                error: Some(e),
            },
            None,
        )
    };
    // fail 路径无缓存条目（CachedTargetReport 无连接引用也构造不出有效预览）

    let Some(tgt_conn) = conn else {
        return fail(TargetError::from(&AppError::NotFound));
    };

    emit_progress(app, index, total, &spec.database, None, "fetch_target", 0);
    let target_snap = match tgt_conn.snapshot_tables(&spec.database, Some(tables)).await {
        Ok(s) => s,
        Err(e) => return fail(TargetError::from(&e)),
    };

    let mut results: Vec<TableDataInternal> = Vec::with_capacity(tables.len());
    for table in tables {
        let src_def = source_snap.tables.iter().find(|t| t.name == *table);
        let tgt_def = target_snap.tables.iter().find(|t| t.name == *table);
        let db_for_progress = spec.database.clone();
        let table_for_progress = table.clone();
        let app_for_progress = app.clone();
        let mut on_progress = move |rows: u64| {
            emit_progress(
                &app_for_progress,
                index,
                total,
                &db_for_progress,
                Some(&table_for_progress),
                "diff",
                rows,
            );
        };
        match datacmp::compare_table(
            src_conn,
            &tgt_conn,
            source_database,
            &spec.database,
            table,
            src_def,
            tgt_def,
            opts,
            &mut on_progress,
        )
        .await
        {
            Ok(r) => results.push(r),
            Err(e) => return fail(TargetError::from(&e)),
        }
    }

    let report_id = Uuid::new_v4().to_string();
    let report = DataTargetReport {
        report_id: report_id.clone(),
        key: spec.key.clone(),
        connection_id: spec.connection_id,
        database: spec.database.clone(),
        tables: results.iter().map(|t| t.to_view(false)).collect(),
        error: None,
    };
    let entry = CachedTargetReport {
        key: spec.key,
        database: spec.database,
        tables: results,
        src_conn: Some(Arc::clone(src_conn)),
        tgt_conn: Some(Arc::clone(&tgt_conn)),
        src_database: source_database.to_string(),
    };
    (report, Some(entry))
}

fn emit_progress(
    app: &AppHandle,
    index: usize,
    total: usize,
    database: &str,
    table: Option<&str>,
    phase: &str,
    rows_compared: u64,
) {
    let _ = app.emit(
        "data-compare-progress",
        serde_json::json!({
            "index": index,
            "total": total,
            "database": database,
            "table": table,
            "phase": phase,
            "rowsCompared": rows_compared,
        }),
    );
}

/// 按需拉取某目标某表的行级明细
#[tauri::command]
pub async fn get_table_diff_detail(
    cache: State<'_, DataCompareCache>,
    report_id: String,
    table: String,
) -> AppResult<TableDataDiff> {
    let guard = cache.inner.lock().await;
    let report = guard.get(&report_id).ok_or(AppError::NotFound)?;
    let t = report
        .tables
        .iter()
        .find(|t| t.table == table)
        .ok_or(AppError::NotFound)?;
    Ok(t.to_view(true))
}

/// 预览同步 SQL：从缓存报告按勾选（表×类别）生成语句
#[tauri::command]
pub async fn preview_data_sync(
    cache: State<'_, DataCompareCache>,
    report_id: String,
    selections: Vec<SyncSelection>,
) -> AppResult<Vec<DataSyncStatement>> {
    let guard = cache.inner.lock().await;
    let report = guard.get(&report_id).ok_or(AppError::NotFound)?;

    // 按表分组勾选，保持报告内表顺序
    let mut by_table: HashMap<&str, Vec<&SyncSelection>> = HashMap::new();
    for s in &selections {
        by_table.entry(s.table.as_str()).or_default().push(s);
    }

    let mut out = Vec::new();
    for t in &report.tables {
        let Some(sels) = by_table.get(t.table.as_str()) else {
            continue;
        };
        let key_idx = t.key_idx();
        for sel in sels {
            // 行级排除：过滤副本的 rows_data 后按单一类别生成语句
            let mut t2 = t.clone();
            if !sel.exclude_keys.is_empty() {
                let excl: std::collections::HashSet<Vec<String>> =
                    sel.exclude_keys.iter().cloned().collect();
                t2.rows_data.retain(|r| {
                    if r.action != sel.action {
                        return true;
                    }
                    let k: Vec<String> = r.key.iter().map(Value::display).collect();
                    !excl.contains(&k)
                });
            }
            for sql in
                datacmp::sqlgen::build_statements(&report.database, &t2, &key_idx, &[sel.action])
            {
                out.push(DataSyncStatement {
                    table: t.table.clone(),
                    action: sel.action,
                    sql,
                });
            }
        }
    }
    Ok(out)
}

/// 行级预览：按键归并拉取两端全行（含一致行），供结果页左右对照展示。
/// limit 防御超大表；截断时 truncated=true。
#[tauri::command]
pub async fn get_table_rows_preview(
    cache: State<'_, DataCompareCache>,
    report_id: String,
    table: String,
    limit: Option<usize>,
) -> AppResult<datacmp::TableRowsPreview> {
    let (src, tgt, src_db, tgt_db) = {
        let guard = cache.inner.lock().await;
        let report = guard.get(&report_id).ok_or(AppError::NotFound)?;
        report
            .tables
            .iter()
            .find(|t| t.table == table)
            .ok_or(AppError::NotFound)?;
        match (&report.src_conn, &report.tgt_conn) {
            (Some(s), Some(t)) => {
                (s.clone(), t.clone(), report.src_database.clone(), report.database.clone())
            }
            _ => return Err(AppError::Internal("该报告不可用（对比失败）".into())),
        }
    };
    datacmp::rows_preview(&src, &tgt, &src_db, &tgt_db, &table, limit.unwrap_or(5000)).await
}

/// 执行数据同步：按表分组，每表一个事务（FK 检查会话内关闭），表间互不影响。
#[tauri::command]
pub async fn apply_data_sync(
    registry: State<'_, Registry>,
    target_connection_id: Uuid,
    statements: Vec<DataSyncStatementInput>,
) -> AppResult<Vec<TableApplyResult>> {
    let conn = registry
        .get(target_connection_id)
        .await
        .ok_or(AppError::NotFound)?;

    // 按表分组并保持语句顺序
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for s in statements {
        let entry = groups.entry(s.table.clone()).or_insert_with(|| {
            order.push(s.table.clone());
            Vec::new()
        });
        entry.push(s.sql);
    }

    let mut results = Vec::with_capacity(order.len());
    for table in order {
        let sqls = groups.remove(&table).unwrap_or_default();
        let count = sqls.len();
        match conn.execute_batch_tx(&sqls).await {
            Ok(()) => results.push(TableApplyResult {
                table,
                ok: true,
                applied_count: count,
                error: None,
            }),
            Err(e) => results.push(TableApplyResult {
                table,
                ok: false,
                applied_count: 0,
                error: Some(e.to_string()),
            }),
        }
    }
    Ok(results)
}

/// apply_data_sync 的输入（sql 由 preview_data_sync 生成，前端原样回传）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncStatementInput {
    pub table: String,
    pub sql: String,
}
