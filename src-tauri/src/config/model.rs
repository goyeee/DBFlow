use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// connections.json 的整体结构。version 用于将来格式迁移。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub version: u32,
    pub groups: Vec<ConnectionGroup>,
    pub connections: Vec<ConnectionProfile>,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            groups: Vec::new(),
            connections: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: Uuid,
    pub name: String,
    pub sort_order: i32,
    pub color: Option<String>,
}

/// 数据库种类。本期只有 MySQL；新增数据库时在此扩展并在 datasource 下新增实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseKind {
    MySql,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: Uuid,
    pub name: String,
    pub group_id: Option<Uuid>,
    /// Navicat 式颜色标签（如 "red" / "#f5222d"），仅展示用
    pub color: Option<String>,
    pub db: DatabaseKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub default_database: Option<String>,
    /// 密码本体只存系统钥匙串，这里只记录"有没有"
    pub has_password: bool,
    pub ssh_has_password: bool,
    pub options: ConnectionOptions,
    pub ssh: Option<SshTunnelConfig>,
    /// epoch 秒
    pub created_at: u64,
    pub updated_at: u64,
}

/// 新建/编辑连接时的入参（时间戳与密码状态由后端维护）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfileInput {
    /// None = 新建；Some = 编辑
    pub id: Option<Uuid>,
    pub name: String,
    pub group_id: Option<Uuid>,
    pub color: Option<String>,
    pub db: DatabaseKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub default_database: Option<String>,
    #[serde(default)]
    pub options: ConnectionOptions,
    pub ssh: Option<SshTunnelConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOptions {
    pub ssl_mode: SslMode,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u32,
    pub charset: Option<String>,
    pub comment: Option<String>,
}

fn default_connect_timeout() -> u32 {
    10
}

impl Default for ConnectionOptions {
    fn default() -> Self {
        Self {
            ssl_mode: SslMode::Preferred,
            connect_timeout_secs: default_connect_timeout(),
            charset: None,
            comment: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disabled,
    Preferred,
    Required,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// 跳板机视角的目标地址；None 时用 profile.host
    pub target_host_override: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

/// SSH 认证方式。密码/私钥口令本体只存钥匙串（ssh:{profile_id}）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum SshAuth {
    Password,
    PrivateKey { key_path: String },
}
