use serde::Serialize;

/// 全局错误类型，序列化为 `{ code, message, detail? }` 传给前端。
/// code 供前端做文案映射/分支判断（如 host_key_unknown 触发指纹确认弹窗）。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("配置读写失败: {0}")]
    Config(String),

    #[error("系统钥匙串访问失败: {0}")]
    Keyring(String),

    #[error("{0}")]
    Db(String),

    #[error("SSH 隧道错误: {0}")]
    Tunnel(String),

    #[error("连接不存在或尚未建立")]
    NotFound,

    #[error("无法确认 SSH 主机身份（指纹 {fingerprint}）")]
    HostKeyUnknown { fingerprint: String },

    #[error("内部错误: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "validation",
            AppError::Io(_) => "io",
            AppError::Config(_) => "config",
            AppError::Keyring(_) => "keyring",
            AppError::Db(_) => "db",
            AppError::Tunnel(_) => "tunnel",
            AppError::NotFound => "not_found",
            AppError::HostKeyUnknown { .. } => "host_key_unknown",
            AppError::Internal(_) => "internal",
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            AppError::HostKeyUnknown { fingerprint } => Some(fingerprint.clone()),
            _ => None,
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Db(friendly_db_error(&e))
    }
}

/// 把 sqlx 错误翻译成用户能看懂的中文提示
fn friendly_db_error(e: &sqlx::Error) -> String {
    let msg = e.to_string();
    if msg.contains("Access denied") {
        "用户名或密码错误（Access denied for user）".to_string()
    } else if msg.contains("Connection refused") {
        "无法连接到服务器：连接被拒绝，请检查主机和端口".to_string()
    } else if msg.contains("timed out") || msg.contains("timeout") {
        "连接超时，请检查网络或防火墙设置".to_string()
    } else if msg.contains("Unknown database") {
        msg.trim_end_matches(" (error 1049)").to_string()
    } else if let Some(db_err) = e.as_database_error() {
        format!("数据库错误 {}: {}", db_err.code().unwrap_or_default(), db_err.message())
    } else {
        msg
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        if let Some(d) = self.detail() {
            map.serialize_entry("detail", d.as_str())?;
        }
        map.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
