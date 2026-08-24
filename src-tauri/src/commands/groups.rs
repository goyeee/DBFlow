use tauri::State;
use uuid::Uuid;

use crate::config::model::ConnectionGroup;
use crate::config::store::ConnectionStore;
use crate::error::{AppError, AppResult};

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn create_group(
    store: State<'_, ConnectionStore>,
    name: String,
) -> AppResult<ConnectionGroup> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("分组名称不能为空".into()));
    }
    let group = ConnectionGroup {
        id: Uuid::new_v4(),
        name,
        sort_order: now_epoch() as i32,
        color: None,
    };
    store
        .mutate(|cfg| {
            cfg.groups.push(group.clone());
            Ok(())
        })
        .await?;
    Ok(group)
}

#[tauri::command]
pub async fn rename_group(
    store: State<'_, ConnectionStore>,
    id: Uuid,
    name: String,
) -> AppResult<ConnectionGroup> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Validation("分组名称不能为空".into()));
    }
    let cfg = store
        .mutate(|cfg| {
            let g = cfg
                .groups
                .iter_mut()
                .find(|g| g.id == id)
                .ok_or(AppError::NotFound)?;
            g.name = name.clone();
            Ok(())
        })
        .await?;
    cfg.groups
        .iter()
        .find(|g| g.id == id)
        .cloned()
        .ok_or(AppError::NotFound)
}

#[tauri::command]
pub async fn delete_group(store: State<'_, ConnectionStore>, id: Uuid) -> AppResult<()> {
    store
        .mutate(|cfg| {
            cfg.groups.retain(|g| g.id != id);
            // 组内连接转未分组
            for c in cfg.connections.iter_mut() {
                if c.group_id == Some(id) {
                    c.group_id = None;
                }
            }
            Ok(())
        })
        .await?;
    Ok(())
}
