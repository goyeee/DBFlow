//! 隧道生命周期：按 (跳板机身份 + 目标地址) 键控复用，引用计数，
//! 归零后 60 秒空闲自动回收。
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::connection::{HostKeyPolicy, SshCredential, SshSession};
use crate::config::model::SshTunnelConfig;
use crate::error::AppResult;

/// 空闲多久后回收（秒）
const IDLE_RECYCLE_SECS: u64 = 60;

/// 同一跳板机 + 同一目标的连接共享同一条 SSH 会话。
/// （不同目标即使同跳板也各开一条：本地监听端口绑定的是单一目标）
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct TunnelKey {
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    target_host: String,
    target_port: u16,
}

struct TunnelEntry {
    local_port: u16,
    /// SSH 会话，回收时主动断开
    session: Option<SshSession>,
    refcount: usize,
    accept_task: tokio::task::JoinHandle<()>,
    /// 空闲回收定时器；被再次 acquire 时取消
    idle_task: Option<tokio::task::JoinHandle<()>>,
}

type SharedMap = Arc<Mutex<HashMap<TunnelKey, TunnelEntry>>>;

#[derive(Default)]
pub struct TunnelManager {
    map: SharedMap,
}

impl TunnelManager {
    /// 获取（或复用）一条到 target 的隧道，返回带本地端点的租约。
    pub async fn acquire(
        &self,
        ssh: &SshTunnelConfig,
        target_host: &str,
        target_port: u16,
        credential: &SshCredential,
        policy: HostKeyPolicy,
    ) -> AppResult<TunnelLease> {
        let key = TunnelKey {
            ssh_host: ssh.host.clone(),
            ssh_port: ssh.port,
            ssh_user: ssh.user.clone(),
            target_host: target_host.to_string(),
            target_port,
        };

        let mut map = self.map.lock().await;
        if let Some(entry) = map.get_mut(&key) {
            if entry.refcount > 0 && !entry.accept_task.is_finished() {
                entry.refcount += 1;
                // 复用：取消空闲回收
                if let Some(idle) = entry.idle_task.take() {
                    idle.abort();
                }
                return Ok(TunnelLease {
                    map: Arc::clone(&self.map),
                    key,
                    local_port: entry.local_port,
                });
            }
            // 原隧道已死：清掉重建
            if let Some(dead) = map.remove(&key) {
                teardown(dead);
            }
        }

        // 建新隧道（持有锁期间其他隧道请求会排队，连接频率低，可接受）
        let session = SshSession::connect(ssh, credential, policy).await?;
        let (local_port, accept_task) =
            session.start_local_forward(target_host.to_string(), target_port).await?;
        map.insert(
            key.clone(),
            TunnelEntry {
                local_port,
                session: Some(session),
                refcount: 1,
                accept_task,
                idle_task: None,
            },
        );
        Ok(TunnelLease {
            map: Arc::clone(&self.map),
            key,
            local_port,
        })
    }
}

async fn release(shared: &SharedMap, key: &TunnelKey) {
    let mut guard = shared.lock().await;
    let Some(entry) = guard.get_mut(key) else {
        return;
    };
    entry.refcount = entry.refcount.saturating_sub(1);
    if entry.refcount == 0 {
        let shared = Arc::clone(shared);
        let key = key.clone();
        let idle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(IDLE_RECYCLE_SECS)).await;
            let mut guard = shared.lock().await;
            if let Some(entry) = guard.get_mut(&key) {
                if entry.refcount == 0 {
                    tracing::debug!(local_port = entry.local_port, "隧道空闲回收");
                    if let Some(dead) = guard.remove(&key) {
                        teardown(dead);
                    }
                }
            }
        });
        entry.idle_task = Some(idle);
    }
}

/// 粗暴但可靠的清理：断 SSH 会话 + 杀 accept 循环（listener 随之释放，端口关闭）
fn teardown(entry: TunnelEntry) {
    if let Some(idle) = entry.idle_task {
        idle.abort();
    }
    entry.accept_task.abort();
    if let Some(session) = entry.session {
        tokio::spawn(async move {
            session.disconnect().await;
        });
    }
}

/// 隧道租约：Drop 时引用计数 -1（异步释放，经 tokio::spawn 投递）
pub struct TunnelLease {
    map: SharedMap,
    key: TunnelKey,
    pub local_port: u16,
}

impl TunnelLease {
    /// 隧道对应的本地端点（MySQL 实际连接这里）
    pub fn endpoint(&self) -> (String, u16) {
        ("127.0.0.1".to_string(), self.local_port)
    }
}

impl Drop for TunnelLease {
    fn drop(&mut self) {
        let map = Arc::clone(&self.map);
        let key = self.key.clone();
        let _ = tokio::spawn(async move {
            release(&map, &key).await;
        });
    }
}

/// 端到端测试（需 docker/testenv 环境，mysql-b 只能经跳板访问）：
///   DBFLOW_E2E=1 cargo test -p dbflow --lib e2e_tunnel -- --nocapture
#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::config::model::{ConnectionProfile, DatabaseKind, SshAuth, SshTunnelConfig};
    use crate::datasource::mysql::{self, ConnectEndpoint, MySqlLive};
    use crate::datasource::LiveConnection;

    fn e2e_enabled() -> bool {
        std::env::var("DBFLOW_E2E").is_ok()
    }

    fn ssh_cfg() -> SshTunnelConfig {
        SshTunnelConfig {
            host: "127.0.0.1".into(),
            port: 2222,
            user: "dbjump".into(),
            auth: SshAuth::Password,
            target_host_override: Some("mysql-b".into()),
        }
    }

    fn mysql_profile() -> ConnectionProfile {
        ConnectionProfile {
            id: uuid::Uuid::new_v4(),
            name: "e2e-tunnel".into(),
            group_id: None,
            color: None,
            db: DatabaseKind::MySql,
            host: "mysql-b".into(), // 会被 target_host_override 覆盖，实际由跳板解析
            port: 3306,
            user: "root".into(),
            default_database: None,
            has_password: true,
            ssh_has_password: true,
            options: Default::default(),
            ssh: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn e2e_tunnel_mysql_full_flow() {
        if !e2e_enabled() {
            eprintln!("跳过（未设置 DBFLOW_E2E）");
            return;
        }
        let manager = TunnelManager::default();
        let cred = SshCredential::Password("dbflow-jump-2026".into());
        // 测试环境的容器密钥是随机生成的，known_hosts 里必然没有：
        // 第一次（未给信任指纹）应返回 HostKeyUnknown
        let fingerprint = match manager
            .acquire(&ssh_cfg(), "mysql-b", 3306, &cred, HostKeyPolicy {
                trusted_fingerprint: None,
                use_known_hosts: false,
            })
            .await
        {
            Err(crate::error::AppError::HostKeyUnknown { fingerprint }) => {
                assert!(fingerprint.starts_with("SHA256:"), "指纹格式异常: {fingerprint}");
                eprintln!("指纹确认流程 OK: {fingerprint}");
                fingerprint
            }
            other => panic!("首次连接未信任时应报 HostKeyUnknown，实际: {:?}", other.map(|_| ())),
        };

        // "用户确认后"带真实指纹重试 → 成功
        let lease = manager
            .acquire(&ssh_cfg(), "mysql-b", 3306, &cred, HostKeyPolicy {
                trusted_fingerprint: Some(fingerprint),
                use_known_hosts: false,
            })
            .await
            .expect("信任指纹后仍失败");
        let (host, port) = lease.endpoint();
        let endpoint = ConnectEndpoint { host, port };
        let pool = mysql::open_pool(&mysql_profile(), &endpoint, Some("dbflow-b-2026"))
            .await
            .expect("经隧道连接 mysql-b 失败");
        let live = MySqlLive::new(pool, Some(lease));

        let version = live.ping().await.expect("ping");
        assert!(version.starts_with('8'), "{version}");
        let dbs = live.list_databases().await.expect("库列表");
        let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"db_log"), "mysql-b 应有 db_log: {names:?}");

        let tables = live.list_tables("db_log").await.expect("表列表");
        let tnames: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert!(tnames.contains(&"error_log"), "mysql-b 独有表 error_log 不在: {tnames:?}");

        live.shutdown().await;
    }
}
