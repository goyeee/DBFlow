use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::config::model::{
    ConnectionProfile, ConnectionProfileInput, SshAuth, SshTunnelConfig,
};
use crate::config::store::ConnectionStore;
use crate::datasource::{mysql, LiveConnection, Registry};
use crate::error::{AppError, AppResult};
use crate::secret::{self, SecretKind};
use crate::tunnel::{HostKeyPolicy, SshCredential, TunnelLease, TunnelManager};

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub groups: Vec<crate::config::model::ConnectionGroup>,
    pub connections: Vec<ConnectionProfile>,
}

#[tauri::command]
pub async fn list_connections(store: State<'_, ConnectionStore>) -> AppResult<ConfigSnapshot> {
    let cfg = store.load().await?;
    Ok(ConfigSnapshot {
        groups: cfg.groups.clone(),
        connections: cfg.connections.clone(),
    })
}

fn validate_input(input: &ConnectionProfileInput) -> AppResult<()> {
    if input.name.trim().is_empty() {
        return Err(AppError::Validation("连接名称不能为空".into()));
    }
    if input.host.trim().is_empty() {
        return Err(AppError::Validation("主机地址不能为空".into()));
    }
    if input.user.trim().is_empty() {
        return Err(AppError::Validation("用户名不能为空".into()));
    }
    if input.port == 0 {
        return Err(AppError::Validation("端口无效".into()));
    }
    if let Some(ssh) = &input.ssh {
        if ssh.host.trim().is_empty() {
            return Err(AppError::Validation("SSH 主机不能为空".into()));
        }
        if ssh.user.trim().is_empty() {
            return Err(AppError::Validation("SSH 用户名不能为空".into()));
        }
        if let SshAuth::PrivateKey { key_path } = &ssh.auth {
            if key_path.trim().is_empty() {
                return Err(AppError::Validation("请填写 SSH 私钥路径".into()));
            }
        }
    }
    Ok(())
}

/// 新建/编辑合一。密码参数语义：None = 不变；Some("") = 清除；Some(p) = 设置。
#[tauri::command]
pub async fn save_connection(
    store: State<'_, ConnectionStore>,
    registry: State<'_, Registry>,
    input: ConnectionProfileInput,
    db_password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
) -> AppResult<ConnectionProfile> {
    validate_input(&input)?;
    let now = now_epoch();

    let (id, created_at, mut has_password, mut ssh_has_password) = match input.id {
        Some(id) => {
            let cfg = store.load().await?;
            let existing = cfg
                .connections
                .iter()
                .find(|c| c.id == id)
                .ok_or(AppError::NotFound)?;
            (
                id,
                existing.created_at,
                existing.has_password,
                existing.ssh_has_password,
            )
        }
        None => (Uuid::new_v4(), now, false, false),
    };

    // 数据库密码
    if let Some(p) = &db_password {
        if p.is_empty() {
            secret::delete(id, SecretKind::Db)?;
            has_password = false;
        } else {
            secret::set(id, SecretKind::Db, p)?;
            has_password = true;
        }
    }

    // SSH 密码 / 私钥口令共用一个槽位（同一时刻只有一种认证方式生效）
    if let Some(p) = ssh_password.as_ref().or(ssh_key_passphrase.as_ref()) {
        if p.is_empty() {
            secret::delete(id, SecretKind::Ssh)?;
            ssh_has_password = false;
        } else {
            secret::set(id, SecretKind::Ssh, p)?;
            ssh_has_password = true;
        }
    }

    // 不再使用隧道时清掉残留的 SSH 凭据
    if input.ssh.is_none() {
        secret::delete(id, SecretKind::Ssh)?;
        ssh_has_password = false;
    }

    let profile = ConnectionProfile {
        id,
        name: input.name.trim().to_string(),
        group_id: input.group_id,
        color: input.color,
        db: input.db,
        host: input.host.trim().to_string(),
        port: input.port,
        user: input.user.trim().to_string(),
        default_database: input
            .default_database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        has_password,
        ssh_has_password,
        options: input.options,
        ssh: input.ssh,
        created_at,
        updated_at: now,
    };

    store
        .mutate(|cfg| {
            match cfg.connections.iter().position(|c| c.id == profile.id) {
                Some(idx) => cfg.connections[idx] = profile.clone(),
                None => cfg.connections.push(profile.clone()),
            }
            Ok(())
        })
        .await?;

    // 编辑了已连接的连接：断开旧会话，下次 connect 用新配置
    registry.remove(id).await;

    Ok(profile)
}

#[tauri::command]
pub async fn delete_connection(
    store: State<'_, ConnectionStore>,
    registry: State<'_, Registry>,
    id: Uuid,
) -> AppResult<()> {
    registry.remove(id).await;
    secret::delete(id, SecretKind::Db)?;
    secret::delete(id, SecretKind::Ssh)?;
    store
        .mutate(|cfg| {
            cfg.connections.retain(|c| c.id != id);
            Ok(())
        })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn duplicate_connection(
    store: State<'_, ConnectionStore>,
    id: Uuid,
) -> AppResult<ConnectionProfile> {
    let cfg = store.load().await?;
    let src = cfg
        .connections
        .iter()
        .find(|c| c.id == id)
        .ok_or(AppError::NotFound)?;

    let new_id = Uuid::new_v4();
    let now = now_epoch();
    let base_name = format!("{} (副本)", src.name);
    let names: HashSet<&str> = cfg.connections.iter().map(|c| c.name.as_str()).collect();
    let mut name = base_name.clone();
    let mut i = 2;
    while names.contains(name.as_str()) {
        name = format!("{} {}", base_name, i);
        i += 1;
    }

    let mut dup = src.clone();
    dup.id = new_id;
    dup.name = name;
    dup.created_at = now;
    dup.updated_at = now;
    dup.has_password = secret::copy(id, new_id, SecretKind::Db)?;
    dup.ssh_has_password = secret::copy(id, new_id, SecretKind::Ssh)?;

    store
        .mutate(|cfg| {
            cfg.connections.push(dup.clone());
            Ok(())
        })
        .await?;
    Ok(dup)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub server_version: Option<String>,
    pub latency_ms: u32,
    pub error: Option<AppError>,
}

/// 表单里的"测试连接"：不落盘、不进注册表，临时隧道 + 单连接查版本，完即拆。
#[tauri::command]
pub async fn test_connection(
    input: ConnectionProfileInput,
    db_password: Option<String>,
    ssh_password: Option<String>,
    ssh_key_passphrase: Option<String>,
    trust_host_key: Option<String>,
    tunnel: State<'_, TunnelManager>,
) -> AppResult<TestResult> {
    if let Err(e) = validate_input(&input) {
        return Ok(TestResult {
            ok: false,
            server_version: None,
            latency_ms: 0,
            error: Some(e),
        });
    }
    let start = std::time::Instant::now();
    match run_test(
        &input,
        db_password,
        ssh_password.or(ssh_key_passphrase),
        trust_host_key,
        &tunnel,
    )
    .await
    {
        Ok(version) => Ok(TestResult {
            ok: true,
            server_version: Some(version),
            latency_ms: start.elapsed().as_millis() as u32,
            error: None,
        }),
        Err(e) => Ok(TestResult {
            ok: false,
            server_version: None,
            latency_ms: start.elapsed().as_millis() as u32,
            error: Some(e),
        }),
    }
}

async fn run_test(
    input: &ConnectionProfileInput,
    db_password: Option<String>,
    ssh_secret: Option<String>,
    trust_host_key: Option<String>,
    tunnel: &TunnelManager,
) -> AppResult<String> {
    // 有效密码：显式传值优先（空 = 不带密码试连）；没传且是编辑场景则取钥匙串
    let db_pw = match db_password {
        Some(p) if !p.is_empty() => Some(p),
        Some(_) => None,
        None => match input.id {
            Some(id) => secret::get(id, SecretKind::Db)?,
            None => None,
        },
    };
    let ssh_pw = match ssh_secret {
        Some(p) if !p.is_empty() => Some(p),
        Some(_) => None,
        None => match (input.ssh.is_some(), input.id) {
            (true, Some(id)) => secret::get(id, SecretKind::Ssh)?,
            _ => None,
        },
    };

    let policy = HostKeyPolicy {
        trusted_fingerprint: trust_host_key,
        use_known_hosts: true,
    };
    let (host, port, _lease) =
        resolve_endpoint(tunnel, &input.host, input.port, input.ssh.as_ref(), ssh_pw, policy)
            .await?;

    // 输入结构 → 完整 profile（fetch_version 只用 options）
    let profile = ConnectionProfile {
        id: input.id.unwrap_or_default(),
        name: input.name.clone(),
        group_id: None,
        color: None,
        db: input.db,
        host: input.host.clone(),
        port: input.port,
        user: input.user.clone(),
        default_database: input.default_database.clone(),
        has_password: false,
        ssh_has_password: false,
        options: input.options.clone(),
        ssh: None,
        created_at: 0,
        updated_at: 0,
    };
    let endpoint = mysql::ConnectEndpoint { host, port };
    let version = mysql::fetch_version(&profile, &endpoint, db_pw.as_deref()).await?;
    // _lease 在此 drop → 隧道引用计数 -1（无其他人用时 60s 后回收）
    Ok(version)
}

/// 解析实际连接端点：无 SSH → 直连；有 SSH → 走（或建）隧道
#[allow(clippy::too_many_arguments)]
async fn resolve_endpoint(
    tunnel: &TunnelManager,
    profile_host: &str,
    profile_port: u16,
    ssh: Option<&SshTunnelConfig>,
    ssh_secret: Option<String>,
    policy: HostKeyPolicy,
) -> AppResult<(String, u16, Option<TunnelLease>)> {
    match ssh {
        None => Ok((profile_host.to_string(), profile_port, None)),
        Some(cfg) => {
            let target_host = cfg
                .target_host_override
                .clone()
                .unwrap_or_else(|| profile_host.to_string());
            let credential = ssh_credential(cfg, ssh_secret);
            let lease = tunnel
                .acquire(cfg, &target_host, profile_port, &credential, policy)
                .await?;
            let (host, port) = lease.endpoint();
            Ok((host, port, Some(lease)))
        }
    }
}

fn ssh_credential(ssh: &SshTunnelConfig, secret: Option<String>) -> SshCredential {
    match &ssh.auth {
        SshAuth::Password => SshCredential::Password(secret.unwrap_or_default()),
        SshAuth::PrivateKey { key_path } => SshCredential::PrivateKey {
            key_path: key_path.clone(),
            passphrase: secret,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub server_version: String,
    pub latency_ms: u32,
}

/// 正式连接：建（或复用）隧道 → 建池 → 注册会话
#[tauri::command]
pub async fn connect(
    id: Uuid,
    trust_host_key: Option<String>,
    store: State<'_, ConnectionStore>,
    tunnel: State<'_, TunnelManager>,
    registry: State<'_, Registry>,
) -> AppResult<ConnectResult> {
    let cfg = store.load().await?;
    let profile = cfg
        .connections
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or(AppError::NotFound)?;

    let db_pw = secret::get(id, SecretKind::Db)?;
    let ssh_pw = if profile.ssh.is_some() {
        secret::get(id, SecretKind::Ssh)?
    } else {
        None
    };

    let start = std::time::Instant::now();
    let policy = HostKeyPolicy {
        trusted_fingerprint: trust_host_key,
        use_known_hosts: true,
    };
    let (host, port, lease) = resolve_endpoint(
        &tunnel,
        &profile.host,
        profile.port,
        profile.ssh.as_ref(),
        ssh_pw,
        policy,
    )
    .await?;

    let endpoint = mysql::ConnectEndpoint { host, port };
    let pool = mysql::open_pool(&profile, &endpoint, db_pw.as_deref()).await?;
    let live = std::sync::Arc::new(mysql::MySqlLive::new(pool, lease));
    let version = live.ping().await?;

    // 顶掉旧会话（shutdown 旧池 + 释放旧隧道租约）
    registry.remove(id).await;
    registry.put(id, live).await;

    Ok(ConnectResult {
        server_version: version,
        latency_ms: start.elapsed().as_millis() as u32,
    })
}

#[tauri::command]
pub async fn disconnect(registry: State<'_, Registry>, id: Uuid) -> AppResult<()> {
    registry.remove(id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::model::{DatabaseKind, SshAuth, SshTunnelConfig};
    use crate::error::AppError;

    /// 复现用户场景：新建表单直接"测试连接"，SSH 隧道开、目标主机覆盖留空
    /// （覆盖为空时应退回常规页主机 mysql-b，由跳板机解析）。
    #[tokio::test]
    async fn e2e_test_connection_via_tunnel_without_override() {
        if std::env::var("DBFLOW_E2E").is_err() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let input = ConnectionProfileInput {
            id: None,
            name: "隧道复现".into(),
            group_id: None,
            color: None,
            db: DatabaseKind::MySql,
            host: "mysql-b".into(),
            port: 3306,
            user: "root".into(),
            default_database: None,
            options: Default::default(),
            ssh: Some(SshTunnelConfig {
                host: "127.0.0.1".into(),
                port: 2222,
                user: "dbjump".into(),
                auth: SshAuth::Password,
                target_host_override: None,
            }),
        };
        let tunnel = crate::tunnel::TunnelManager::default();
        let db_pw = Some("dbflow-b-2026".to_string());
        let ssh_pw = Some("dbflow-jump-2026".to_string());

        // 首次可能报 HostKeyUnknown → 带上指纹重试（与前端"信任并继续"一致）
        let version = match run_test(&input, db_pw.clone(), ssh_pw.clone(), None, &tunnel).await {
            Ok(v) => v,
            Err(AppError::HostKeyUnknown { fingerprint }) => {
                run_test(&input, db_pw, ssh_pw, Some(fingerprint), &tunnel)
                    .await
                    .expect("信任指纹后测试连接仍失败")
            }
            Err(e) => panic!("测试连接失败: {e}"),
        };
        eprintln!("== 隧道测试连接成功，版本: {version}");
        assert!(!version.is_empty());
    }
}
