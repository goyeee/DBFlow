use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::model::ConfigFile;
use crate::error::{AppError, AppResult};

/// connections.json 的读写入口。
/// - 读：内存缓存，未命中时读文件；文件缺失/损坏时回退到空配置（损坏文件备份为 .corrupt）
/// - 写：全量写回，走 临时文件 → fsync → rename 原子替换，避免半截文件
pub struct ConnectionStore {
    path: PathBuf,
    cache: Mutex<Option<Arc<ConfigFile>>>,
}

impl ConnectionStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            path: config_dir.join("connections.json"),
            cache: Mutex::new(None),
        }
    }

    /// 配置目录（打开给用户看 / 排查问题用）
    pub fn config_dir(&self) -> PathBuf {
        self.path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default()
    }

    pub async fn load(&self) -> AppResult<Arc<ConfigFile>> {
        let mut guard = self.cache.lock().await;
        if let Some(cached) = guard.as_ref() {
            return Ok(cached.clone());
        }
        let loaded = Arc::new(self.load_from_disk()?);
        *guard = Some(loaded.clone());
        Ok(loaded)
    }

    fn load_from_disk(&self) -> AppResult<ConfigFile> {
        match std::fs::read(&self.path) {
            Ok(bytes) => match serde_json::from_slice::<ConfigFile>(&bytes) {
                Ok(cfg) => Ok(cfg),
                Err(e) => {
                    // 损坏：备份后回退空配置，不让应用起不来
                    let backup = self.path.with_extension("json.corrupt");
                    let _ = std::fs::rename(&self.path, &backup);
                    tracing::warn!(
                        "connections.json 解析失败（{}），已备份到 {:?}，使用空配置",
                        e,
                        backup
                    );
                    Ok(ConfigFile::default())
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConfigFile::default()),
            Err(e) => Err(AppError::Config(format!("读取 {}: {}", self.path.display(), e))),
        }
    }

    /// 在写锁内修改配置并原子落盘，返回修改后的快照
    pub async fn mutate<F>(&self, f: F) -> AppResult<Arc<ConfigFile>>
    where
        F: FnOnce(&mut ConfigFile) -> AppResult<()>,
    {
        let mut guard = self.cache.lock().await;
        let mut cfg = match guard.as_ref() {
            Some(cached) => (**cached).clone(),
            None => self.load_from_disk()?,
        };
        f(&mut cfg)?;
        self.write_to_disk(&cfg)?;
        let arc = Arc::new(cfg);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    fn write_to_disk(&self, cfg: &ConfigFile) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(cfg)
            .map_err(|e| AppError::Config(format!("序列化失败: {}", e)))?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
            .map_err(|e| AppError::Config(format!("写入 {}: {}", self.path.display(), e)))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::{ConnectionGroup, ConnectionProfile, DatabaseKind};

    fn store_in(dir: &std::path::Path) -> ConnectionStore {
        ConnectionStore::new(dir.to_path_buf())
    }

    #[tokio::test]
    async fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("dbflow-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = store_in(&dir);

        let group_id = uuid::Uuid::new_v4();
        store
            .mutate(|cfg| {
                cfg.groups.push(ConnectionGroup {
                    id: group_id,
                    name: "测试组".into(),
                    sort_order: 0,
                    color: None,
                });
                cfg.connections.push(ConnectionProfile {
                    id: uuid::Uuid::new_v4(),
                    name: "本地 MySQL".into(),
                    group_id: Some(group_id),
                    color: Some("red".into()),
                    db: DatabaseKind::MySql,
                    host: "127.0.0.1".into(),
                    port: 3306,
                    user: "root".into(),
                    default_database: Some("db_shop".into()),
                    has_password: true,
                    ssh_has_password: false,
                    options: Default::default(),
                    ssh: None,
                    created_at: 1_800_000_000,
                    updated_at: 1_800_000_000,
                });
                Ok(())
            })
            .await
            .unwrap();

        // 新实例（无缓存）从磁盘读回，验证持久化
        let store2 = store_in(&dir);
        let cfg = store2.load().await.unwrap();
        assert_eq!(cfg.groups.len(), 1);
        assert_eq!(cfg.connections.len(), 1);
        assert_eq!(cfg.connections[0].name, "本地 MySQL");
        assert_eq!(cfg.connections[0].port, 3306);
    }

    #[tokio::test]
    async fn corrupt_file_falls_back_to_empty() {
        let dir = std::env::temp_dir().join(format!("dbflow-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("connections.json"), "{ 不是合法 json").unwrap();
        let store = store_in(&dir);
        let cfg = store.load().await.unwrap();
        assert!(cfg.connections.is_empty());
        // 损坏文件被备份
        assert!(dir.join("connections.json.corrupt").exists());
    }
}
