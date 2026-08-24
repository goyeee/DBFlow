use std::collections::HashMap;
use std::sync::Mutex;

use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// 密码存系统钥匙串（macOS Keychain / Windows Credential Manager）。
/// - service 固定为 com.dbflow.secrets
/// - account 为 "{kind}:{profile_id}"，删除连接时按 uuid 成对清理
///
/// 进程内缓存：macOS 对每次钥匙串读取都可能弹授权框（dev 版二进制签名每次
/// 编译都变，"始终允许"记不住）。首次读取后缓存到内存，本次运行不再弹窗。
/// 安全权衡：密码本来就会在连接时进入进程内存，桌面应用可接受。
const SERVICE: &str = "com.dbflow.secrets";

type CacheKey = (Uuid, SecretKind);
static CACHE: Mutex<Option<HashMap<CacheKey, String>>> = Mutex::new(None);

fn cache_put(key: CacheKey, value: String) {
    CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(key, value);
}

fn cache_get(key: &CacheKey) -> Option<String> {
    CACHE.lock().unwrap().as_ref()?.get(key).cloned()
}

fn cache_remove(key: &CacheKey) {
    if let Some(map) = CACHE.lock().unwrap().as_mut() {
        map.remove(key);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SecretKind {
    /// 数据库密码
    Db,
    /// SSH 密码或私钥口令（同一时刻只有一种生效，共用一个槽位）
    Ssh,
}

impl SecretKind {
    fn tag(&self) -> &'static str {
        match self {
            SecretKind::Db => "db",
            SecretKind::Ssh => "ssh",
        }
    }
}

fn account(profile_id: Uuid, kind: SecretKind) -> String {
    format!("{}:{}", kind.tag(), profile_id)
}

pub fn set(profile_id: Uuid, kind: SecretKind, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id, kind))?;
    entry.set_password(secret).map_err(AppError::from)?;
    cache_put((profile_id, kind), secret.to_string());
    Ok(())
}

/// 不存在时返回 None。命中进程内缓存时不触碰钥匙串（避免重复弹授权框）。
pub fn get(profile_id: Uuid, kind: SecretKind) -> AppResult<Option<String>> {
    if let Some(v) = cache_get(&(profile_id, kind)) {
        return Ok(Some(v));
    }
    let entry = keyring::Entry::new(SERVICE, &account(profile_id, kind))?;
    match entry.get_password() {
        Ok(s) => {
            cache_put((profile_id, kind), s.clone());
            Ok(Some(s))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

/// 删除；条目不存在视为成功
pub fn delete(profile_id: Uuid, kind: SecretKind) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id, kind))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }?;
    cache_remove(&(profile_id, kind));
    Ok(())
}

/// 复制（用于"复制连接"）。源无密码时返回 false 且不创建新条目。
pub fn copy(from: Uuid, to: Uuid, kind: SecretKind) -> AppResult<bool> {
    match get(from, kind)? {
        Some(secret) => {
            set(to, kind, &secret)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

// 需要真实系统钥匙串，只能手动跑：cargo test -- --ignored
#[test]
#[ignore]
fn keyring_roundtrip() {
    let id = Uuid::new_v4();
    set(id, SecretKind::Db, "secret-密码").unwrap();
    assert_eq!(get(id, SecretKind::Db).unwrap().as_deref(), Some("secret-密码"));
    delete(id, SecretKind::Db).unwrap();
    assert_eq!(get(id, SecretKind::Db).unwrap(), None);
}
