//! russh 的所有调用都集中在本文件，升级 russh 只需要改这里。
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};

use crate::config::model::SshTunnelConfig;
use crate::error::{AppError, AppResult};

/// SSH 认证凭据（由调用方从 keyring / 表单临时输入解析得到）
pub enum SshCredential {
    Password(String),
    PrivateKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

/// 主机指纹策略：先看用户已信任的指纹，再查 known_hosts，都不匹配则拒绝
/// 并把实际指纹带回去让前端弹确认框。
pub struct HostKeyPolicy {
    /// 用户在确认框里点"信任并继续"后回传的指纹
    pub trusted_fingerprint: Option<String>,
    /// 是否检查 ~/.ssh/known_hosts
    pub use_known_hosts: bool,
}

impl Default for HostKeyPolicy {
    fn default() -> Self {
        Self {
            trusted_fingerprint: None,
            use_known_hosts: true,
        }
    }
}

struct ClientHandler {
    ssh_host: String,
    ssh_port: u16,
    policy: HostKeyPolicy,
    /// 握手过程中见到的服务器指纹（即使被拒绝也记录，供前端展示）
    seen_fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        tracing::debug!(fingerprint = %fp, "SSH 主机指纹");
        *self.seen_fingerprint.lock().unwrap() = Some(fp.clone());

        if let Some(trusted) = &self.policy.trusted_fingerprint {
            if &fp == trusted {
                return Ok(true);
            }
        }
        if self.policy.use_known_hosts {
            let result = russh::keys::known_hosts::check_known_hosts(
                &self.ssh_host,
                self.ssh_port,
                server_public_key,
            );
            match result {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                // known_hosts 文件本身有问题（不可读/格式错）按未匹配处理，交给用户确认
                Err(e) => tracing::warn!("known_hosts 检查失败: {}", e),
            }
        }
        Ok(false)
    }
}

/// 一条已认证的 SSH 会话
pub struct SshSession {
    handle: Arc<Handle<ClientHandler>>,
}

impl SshSession {
    /// 建立 SSH 连接并认证。
    /// 主机指纹不认识时返回 HostKeyUnknown（指纹在 detail 里），前端确认后
    /// 带 trusted_fingerprint 重试。
    pub async fn connect(
        ssh: &SshTunnelConfig,
        credential: &SshCredential,
        policy: HostKeyPolicy,
    ) -> AppResult<Self> {
        let seen = Arc::new(Mutex::new(None));
        let handler = ClientHandler {
            ssh_host: ssh.host.clone(),
            ssh_port: ssh.port,
            policy,
            seen_fingerprint: seen.clone(),
        };

        let config = Arc::new(client::Config::default());
        let mut handle = match client::connect(config, (ssh.host.as_str(), ssh.port), handler).await
        {
            Ok(h) => h,
            Err(russh::Error::UnknownKey) => {
                let fp = seen.lock().unwrap().clone().unwrap_or_default();
                return Err(AppError::HostKeyUnknown { fingerprint: fp });
            }
            Err(e) => {
                // 某些场景把"拒绝主机密钥"包成连接层错误；只要见过指纹就按指纹问题处理
                let fp = seen.lock().unwrap().clone();
                let msg = e.to_string();
                if let Some(fp) = fp {
                    if msg.contains("check_server_key") || msg.contains("UnknownKey") {
                        return Err(AppError::HostKeyUnknown { fingerprint: fp });
                    }
                }
                return Err(AppError::Tunnel(format!(
                    "无法连接跳板机 {}:{} — {}",
                    ssh.host,
                    ssh.port,
                    friendly_ssh_error(&e)
                )));
            }
        };

        let auth_ok = match credential {
            SshCredential::Password(pw) => handle
                .authenticate_password(&ssh.user, pw)
                .await
                .map_err(|e| AppError::Tunnel(format!("SSH 认证失败: {}", e)))?
                .success(),
            SshCredential::PrivateKey {
                key_path,
                passphrase,
            } => {
                let key = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| AppError::Tunnel(format!("读取私钥失败: {}", e)))?;
                let with_hash = russh::keys::PrivateKeyWithHashAlg::new(
                    Arc::new(key),
                    Some(russh::keys::HashAlg::Sha256),
                );
                handle
                    .authenticate_publickey(&ssh.user, with_hash)
                    .await
                    .map_err(|e| AppError::Tunnel(format!("SSH 认证失败: {}", e)))?
                    .success()
            }
        };
        if !auth_ok {
            return Err(AppError::Tunnel(
                "SSH 认证失败：用户名、密码或私钥不正确".to_string(),
            ));
        }

        Ok(Self {
            handle: Arc::new(handle),
        })
    }

    /// 在本机随机端口开监听，把进入的 TCP 流经 SSH 转发到 target。
    /// 返回 (本地端口, accept 循环任务句柄)。会话本体由调用方持有用于回收。
    pub async fn start_local_forward(
        &self,
        target_host: String,
        target_port: u16,
    ) -> AppResult<(u16, tokio::task::JoinHandle<()>)> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| AppError::Tunnel(format!("无法创建本地隧道端口: {}", e)))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AppError::Tunnel(e.to_string()))?
            .port();

        let handle = Arc::clone(&self.handle);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    break;
                };
                let handle = Arc::clone(&handle);
                let target_host = target_host.clone();
                tokio::spawn(async move {
                    match handle
                        .channel_open_direct_tcpip(&target_host, target_port as u32, "127.0.0.1", 0)
                        .await
                    {
                        Ok(channel) => {
                            let mut stream = channel.into_stream();
                            // 双向搬运直到任一侧断开
                            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                        }
                        Err(e) => {
                            tracing::warn!("SSH channel 建立失败: {}", e);
                            use tokio::io::AsyncWriteExt;
                            let _ = tcp.shutdown().await;
                        }
                    }
                });
            }
        });

        Ok((local_port, task))
    }

    /// 主动断开 SSH 会话（回收隧道时调用）
    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

fn friendly_ssh_error(e: &russh::Error) -> String {
    let msg = e.to_string();
    if msg.contains("Connection refused") {
        "连接被拒绝，请检查跳板机地址和端口".to_string()
    } else if msg.contains("timed out") || msg.contains("timeout") {
        "连接超时，请检查网络或防火墙".to_string()
    } else {
        msg
    }
}
