use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// 密码存系统钥匙串（macOS Keychain / Windows Credential Manager）。
/// - service 固定为 com.dbflow.secrets
/// - account 为 "{kind}:{profile_id}"，删除连接时按 uuid 成对清理
///
/// 进程内缓存：macOS 对每次钥匙串读取都可能弹授权框（dev 版二进制签名每次
/// 编译都变，"始终允许"记不住）。首次读取后缓存到内存，本次运行不再弹窗。
/// 安全权衡：密码本来就会在连接时进入进程内存，桌面应用可接受。
///
/// "记住密码"：勾选后密码同时写入配置目录的 secrets.json（仅混淆、非加密，
/// 见文件底部说明），读取时优先命中本地文件，彻底绕开钥匙串授权问题。
///
/// dev 构建（debug_assertions）额外自动落盘：set 时同步写本地，get 从钥匙串
/// 读到后也迁移写本地——老连接最多再弹一次授权框，此后重编译永远不再弹。
/// 发布版不受影响，仍严格按「记住密码」勾选决定是否落盘。
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
    // dev 构建二进制签名每次编译都变，钥匙串 ACL 记不住——同步落一份本地，
    // 让读取命中文件、彻底绕开钥匙串。发布版仍按「记住密码」勾选走 sync_local。
    #[cfg(debug_assertions)]
    {
        let _ = set_local(profile_id, kind, secret);
    }
    Ok(())
}

/// 读取顺序：内存缓存 → 本地 secrets.json → 系统钥匙串。
/// 勾选过"记住密码"的条目落在本地文件里，优先命中文件，完全不碰钥匙串，
/// 因此 dev 重编译（二进制签名变化）后也不会再弹授权框。
pub fn get(profile_id: Uuid, kind: SecretKind) -> AppResult<Option<String>> {
    if let Some(v) = cache_get(&(profile_id, kind)) {
        return Ok(Some(v));
    }
    if let Some(v) = get_local(profile_id, kind) {
        cache_put((profile_id, kind), v.clone());
        return Ok(Some(v));
    }
    let entry = keyring::Entry::new(SERVICE, &account(profile_id, kind))?;
    match entry.get_password() {
        Ok(s) => {
            // dev 构建读到钥匙串后迁移到本地文件：老连接只弹这一次，之后重编译不再弹
            #[cfg(debug_assertions)]
            {
                let _ = set_local(profile_id, kind, &s);
            }
            cache_put((profile_id, kind), s.clone());
            Ok(Some(s))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

/// 删除（钥匙串 + 本地文件一并清理）；条目不存在视为成功
pub fn delete(profile_id: Uuid, kind: SecretKind) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE, &account(profile_id, kind))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }?;
    let _ = delete_local(profile_id, kind);
    cache_remove(&(profile_id, kind));
    Ok(())
}

/// 复制（用于"复制连接"）。源无密码时返回 false 且不创建新条目。
/// get 已含本地文件回退，dev 下钥匙串读不到也能复制；源在本地文件里时副本同样落盘。
pub fn copy(from: Uuid, to: Uuid, kind: SecretKind) -> AppResult<bool> {
    match get(from, kind)? {
        Some(secret) => {
            set(to, kind, &secret)?;
            if get_local(from, kind).is_some() {
                let _ = set_local(to, kind, &secret);
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// 本地 secrets.json（"记住密码"勾选后启用）
//
// 安全说明：这只是 XOR + hex 混淆，不是加密。任何能读到该文件的人都能还原
// 密码——安全级别与 Navicat 的本地密码存储相当，依赖文件权限（0600）和
// 系统账户隔离。勾选"记住密码"即表示接受此权衡，换来 dev 重编译/重启后
// 不再被钥匙串授权框打扰。
// ---------------------------------------------------------------------------

static LOCAL_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 应用启动时注入配置目录（secrets.json 与 connections.json 同目录）。
/// 未初始化时本地存储静默禁用（单元测试场景）。
pub fn init_local_dir(dir: PathBuf) {
    *LOCAL_DIR.lock().unwrap() = Some(dir);
}

fn local_path() -> Option<PathBuf> {
    LOCAL_DIR
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| d.join("secrets.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretsFile {
    #[serde(default)]
    version: u32,
    /// account("db:{uuid}") → 混淆后的密码
    #[serde(default)]
    secrets: HashMap<String, String>,
}

/// 固定混淆密钥：只防"打开文件一眼看到明文"，不防有心人
const OBFUSCATE_KEY: &[u8] = b"dbflow-local-secrets-v1";

fn obfuscate(secret: &str) -> String {
    let bytes: Vec<u8> = secret
        .as_bytes()
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ OBFUSCATE_KEY[i % OBFUSCATE_KEY.len()])
        .collect();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn deobfuscate(encoded: &str) -> Option<String> {
    if encoded.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..encoded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&encoded[i..i + 2], 16).ok())
        .collect();
    let bytes = bytes?;
    let plain: Vec<u8> = bytes
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ OBFUSCATE_KEY[i % OBFUSCATE_KEY.len()])
        .collect();
    String::from_utf8(plain).ok()
}

fn read_local_file(path: &Path) -> SecretsFile {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            tracing::warn!("secrets.json 解析失败（{}），按空文件处理", e);
            SecretsFile::default()
        }),
        Err(_) => SecretsFile::default(),
    }
}

fn write_local_file(path: &Path, file: &SecretsFile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(file)
        .map_err(|e| AppError::Config(format!("序列化 secrets.json 失败: {}", e)))?;
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    // 仅当前用户可读写
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Config(format!("写入 {}: {}", path.display(), e)))?;
    Ok(())
}

/// 写入本地文件（勾选"记住密码"时由命令层调用）。未初始化目录时为无操作。
pub fn set_local(profile_id: Uuid, kind: SecretKind, secret: &str) -> AppResult<()> {
    let Some(path) = local_path() else {
        return Ok(());
    };
    set_local_in(&path, profile_id, kind, secret)
}

fn set_local_in(path: &Path, profile_id: Uuid, kind: SecretKind, secret: &str) -> AppResult<()> {
    let mut file = read_local_file(path);
    file.version = 1;
    file.secrets
        .insert(account(profile_id, kind), obfuscate(secret));
    write_local_file(path, &file)?;
    cache_put((profile_id, kind), secret.to_string());
    Ok(())
}

pub fn delete_local(profile_id: Uuid, kind: SecretKind) -> AppResult<()> {
    let Some(path) = local_path() else {
        return Ok(());
    };
    delete_local_in(&path, profile_id, kind)
}

fn delete_local_in(path: &Path, profile_id: Uuid, kind: SecretKind) -> AppResult<()> {
    let mut file = read_local_file(path);
    if file.secrets.remove(&account(profile_id, kind)).is_some() {
        write_local_file(path, &file)?;
    }
    Ok(())
}

fn get_local(profile_id: Uuid, kind: SecretKind) -> Option<String> {
    let path = local_path()?;
    get_local_in(&path, profile_id, kind)
}

fn get_local_in(path: &Path, profile_id: Uuid, kind: SecretKind) -> Option<String> {
    let file = read_local_file(path);
    let encoded = file.secrets.get(&account(profile_id, kind))?;
    match deobfuscate(encoded) {
        Some(v) => Some(v),
        None => {
            tracing::warn!("secrets.json 中 {} 条目损坏，忽略", account(profile_id, kind));
            None
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 只有操作全局 LOCAL_DIR 的测试需要抢这把锁（cargo test 默认并行）
    static GLOBAL_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbflow-secret-test-{}-{}", tag, Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn obfuscate_roundtrip() {
        for s in ["", "a", "secret-密码-!@#$%", "长一点儿的密码 with spaces"] {
            assert_eq!(deobfuscate(&obfuscate(s)).as_deref(), Some(s));
        }
        // 混淆后不是明文
        assert_ne!(obfuscate("hunter2"), "hunter2");
        // 损坏输入安全返回 None
        assert_eq!(deobfuscate("zz"), None);
        assert_eq!(deobfuscate("abc"), None);
    }

    #[test]
    fn local_file_roundtrip_and_delete() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("secrets.json");

        let id = Uuid::new_v4();
        set_local_in(&path, id, SecretKind::Db, "本地密码").unwrap();
        assert_eq!(get_local_in(&path, id, SecretKind::Db).as_deref(), Some("本地密码"));
        // 不同 kind / 不同 id 互不影响
        assert_eq!(get_local_in(&path, id, SecretKind::Ssh), None);
        assert_eq!(get_local_in(&path, Uuid::new_v4(), SecretKind::Db), None);

        // 文件确实存在且不含明文
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("本地密码"));

        delete_local_in(&path, id, SecretKind::Db).unwrap();
        assert_eq!(get_local_in(&path, id, SecretKind::Db), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_prefers_local_file_over_keychain() {
        let _guard = GLOBAL_LOCK.lock().unwrap();
        let dir = temp_dir("global");
        init_local_dir(dir.clone());

        let id = Uuid::new_v4();
        set_local(id, SecretKind::Db, "文件里的密码").unwrap();
        // 清掉缓存，强制走"本地文件 → 钥匙串"查找；命中文件即返回，不触碰钥匙串
        cache_remove(&(id, SecretKind::Db));
        assert_eq!(get(id, SecretKind::Db).unwrap().as_deref(), Some("文件里的密码"));

        delete(id, SecretKind::Db).unwrap();
        // 本地条目已删；钥匙串里这个随机 uuid 必然不存在 → None（不会弹授权框）
        cache_remove(&(id, SecretKind::Db));
        assert_eq!(get(id, SecretKind::Db).unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn local_file_permissions_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        let path = dir.join("secrets.json");
        set_local_in(&path, Uuid::new_v4(), SecretKind::Ssh, "p").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_local_file_treated_as_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join("secrets.json");
        std::fs::write(&path, "{ 不是合法 json").unwrap();
        assert_eq!(get_local_in(&path, Uuid::new_v4(), SecretKind::Db), None);
        // 写入会覆盖坏文件恢复正常
        let id = Uuid::new_v4();
        set_local_in(&path, id, SecretKind::Db, "x").unwrap();
        assert_eq!(get_local_in(&path, id, SecretKind::Db).as_deref(), Some("x"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
