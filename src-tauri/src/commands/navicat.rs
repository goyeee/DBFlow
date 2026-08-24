use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::config::model::{ConnectionProfile, DatabaseKind};
use crate::config::store::ConnectionStore;
use crate::error::{AppError, AppResult};
use crate::navicat::{self, NavicatCandidate};
use crate::secret::{self, SecretKind};

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 扫描本机 Navicat 配置（macOS Profiles / Windows 注册表）
#[tauri::command]
pub async fn navicat_scan() -> AppResult<Vec<NavicatCandidate>> {
    Ok(navicat::scan_local())
}

/// 解析用户选择的 Navicat 导出文件（.ncx）
#[tauri::command]
pub async fn navicat_import_ncx(path: String) -> AppResult<Vec<NavicatCandidate>> {
    let xml = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Validation(format!("无法读取文件 {}: {}", path, e)))?;
    Ok(navicat::ncx::candidates_from_str(&xml, "NcxFile"))
}

/// 前端勾选的候选（不带密码本体——导入时后端重扫匹配，密码不经过前端内存）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavicatImportSelection {
    pub source_name: String,
    pub origin: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub group_id: Option<Uuid>,
    /// origin 为 NcxFile 时的来源文件路径
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavicatImportResult {
    pub imported: usize,
    pub failed: Vec<ImportFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub name: String,
    pub reason: String,
}

#[tauri::command]
pub async fn navicat_import(
    store: State<'_, ConnectionStore>,
    selections: Vec<NavicatImportSelection>,
) -> AppResult<NavicatImportResult> {
    // 重新扫描拿全量候选（含解密后的密码），按前端勾选回填
    let mut candidates = navicat::scan_local();
    let ncx_paths: Vec<String> = selections
        .iter()
        .filter_map(|s| s.path.clone())
        .collect();
    for path in ncx_paths {
        if let Ok(xml) = std::fs::read_to_string(&path) {
            candidates.extend(navicat::ncx::candidates_from_str(&xml, "NcxFile"));
        }
    }

    let mut result = NavicatImportResult {
        imported: 0,
        failed: Vec::new(),
    };

    for sel in &selections {
        let found = candidates.iter().find(|c| {
            c.source_name == sel.source_name
                && c.origin == sel.origin
                && c.host == sel.host
                && c.port == sel.port
                && c.user == sel.user
        });
        let Some(c) = found else {
            result.failed.push(ImportFailure {
                name: sel.source_name.clone(),
                reason: "导入时未能重新匹配到该连接（配置可能刚被修改）".into(),
            });
            continue;
        };

        if c.kind != "mysql" {
            result.failed.push(ImportFailure {
                name: c.source_name.clone(),
                reason: format!("暂不支持的数据库类型：{}", c.kind),
            });
            continue;
        }

        let existing = store.load().await?;
        let mut name = c.source_name.clone();
        let mut i = 2;
        while existing.connections.iter().any(|x| x.name == name) {
            name = format!("{} {}", c.source_name, i);
            i += 1;
        }

        let id = Uuid::new_v4();
        let now = now_epoch();
        let profile = ConnectionProfile {
            id,
            name: name.clone(),
            group_id: sel.group_id,
            color: None,
            db: DatabaseKind::MySql,
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            default_database: c.database.clone(),
            has_password: c.password.as_deref().map(|p| !p.is_empty()).unwrap_or(false),
            ssh_has_password: c.ssh_password.is_some(),
            options: Default::default(),
            ssh: c.ssh.clone(),
            created_at: now,
            updated_at: now,
        };

        // 密码直接进钥匙串
        if let Some(pw) = &c.password {
            if !pw.is_empty() && secret::set(id, SecretKind::Db, pw).is_err() {
                result.failed.push(ImportFailure {
                    name,
                    reason: "密码写入系统钥匙串失败".into(),
                });
                continue;
            }
        }
        if let Some(pw) = &c.ssh_password {
            let _ = secret::set(id, SecretKind::Ssh, pw);
        }

        store
            .mutate(|cfg| {
                cfg.connections.push(profile.clone());
                Ok(())
            })
            .await?;
        result.imported += 1;
    }

    Ok(result)
}

/// 打开配置目录（排查 connections.json 用）
#[tauri::command]
pub fn open_config_dir(
    app: tauri::AppHandle,
    store: State<'_, ConnectionStore>,
) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = store.config_dir();
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::Internal(format!("打开目录失败: {}", e)))?;
    Ok(())
}
