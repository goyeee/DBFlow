use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// er-models/ 目录下 ER 模型文档（.er.json）的读写入口。
/// 文档结构由前端拥有（serde_json::Value 透传），这里只负责按
/// 连接+库定位文件与原子落盘（临时文件 → rename）。
pub struct ErModelStore {
    dir: PathBuf,
}

impl ErModelStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            dir: config_dir.join("er-models"),
        }
    }

    pub fn load(&self, connection_id: &str, database: &str) -> AppResult<Option<serde_json::Value>> {
        let path = self.dir.join(model_file_name(connection_id, database)?);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| AppError::Config(format!("ER 模型文档解析失败: {}", e))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::Config(format!("读取 {}: {}", path.display(), e))),
        }
    }

    pub fn save(
        &self,
        connection_id: &str,
        database: &str,
        doc: serde_json::Value,
    ) -> AppResult<()> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(model_file_name(connection_id, database)?);
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&doc)
            .map_err(|e| AppError::Config(format!("序列化失败: {}", e)))?;
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)
            .map_err(|e| AppError::Config(format!("写入 {}: {}", path.display(), e)))?;
        Ok(())
    }

    pub fn delete(&self, connection_id: &str, database: &str) -> AppResult<()> {
        let path = self.dir.join(model_file_name(connection_id, database)?);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Config(format!("删除 {}: {}", path.display(), e))),
        }
    }
}

/// 文件名：`{connectionId}__{encodedDatabase}.er.json`。
/// connection_id 维持严格白名单（ASCII 字母数字与 -_.）；database 做百分号编码：
/// ASCII 安全字符保留（旧文件名不变），其余（含中文、'/'、空白）编码为 %XX，
/// 既支持非 ASCII 库名又消除路径分隔符，防止路径穿越。
fn model_file_name(connection_id: &str, database: &str) -> AppResult<String> {
    let cid_bad = |s: &str| {
        s.is_empty()
            || s == "."
            || s == ".."
            || s.split('.').any(|seg| seg.is_empty())
            || s.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'))
    };
    if cid_bad(connection_id) {
        return Err(AppError::Config("连接 ID 含非法字符".into()));
    }
    if database.is_empty() {
        return Err(AppError::Config("库名不能为空".into()));
    }
    let mut encoded = String::new();
    for b in database.bytes() {
        let safe = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.');
        if safe {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(format!("{}__{}.er.json", connection_id, encoded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbflow-er-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = tmp_dir();
        let store = ErModelStore::new(dir.clone());
        let doc = serde_json::json!({
            "formatVersion": 1,
            "kind": "mysql",
            "database": "db_shop",
            "tables": [{ "id": "users", "name": "users", "x": 10.0, "y": 20.0, "collapsed": false }],
            "edges": []
        });
        store.save("c1", "db_shop", doc.clone()).unwrap();

        // 新实例（无缓存）从磁盘读回
        let store2 = ErModelStore::new(dir);
        assert_eq!(store2.load("c1", "db_shop").unwrap(), Some(doc));
    }

    #[test]
    fn load_missing_returns_none() {
        let store = ErModelStore::new(tmp_dir());
        assert_eq!(store.load("c1", "db_missing").unwrap(), None);
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tmp_dir();
        let store = ErModelStore::new(dir);
        store.save("c1", "db1", serde_json::json!({})).unwrap();
        store.delete("c1", "db1").unwrap();
        store.delete("c1", "db1").unwrap(); // 已删再删不报错
        assert_eq!(store.load("c1", "db1").unwrap(), None);
    }

    #[test]
    fn rejects_unsafe_connection_id() {
        let store = ErModelStore::new(tmp_dir());
        // connection_id 含路径穿越/为空 → 拒绝
        assert!(store.save("../../../root", "db", serde_json::json!({})).is_err());
        assert!(store.load("", "db").is_err());
        assert!(store.load("../evil", "db").is_err());
        // 合法字符（uuid、中横线）不受影响
        assert!(store.load("0b6f6a3e-1111-2222-3333-444455556666", "db").is_ok());
    }

    #[test]
    fn database_name_encoded_safely() {
        let store = ErModelStore::new(tmp_dir());
        // 危险库名被百分号编码：文件名不含路径分隔符，可安全定位
        let fname = model_file_name("c1", "../evil").unwrap();
        assert!(!fname.contains('/'));
        assert!(fname.contains('%'));
        assert_eq!(store.load("c1", "../evil").unwrap(), None);
        // 点号/中横线 ASCII 库名保持原样
        assert_eq!(model_file_name("c1", "db-shop.v2").unwrap(), "c1__db-shop.v2.er.json");
        // 中文库名 roundtrip：保存与读取用同一编码
        let doc = serde_json::json!({ "formatVersion": 1 });
        store.save("c1", "测试库", doc.clone()).unwrap();
        assert_eq!(store.load("c1", "测试库").unwrap(), Some(doc));
    }
}
