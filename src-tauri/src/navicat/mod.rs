pub mod decrypt;
pub mod ncx;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod windows;

use serde::Serialize;

use crate::config::model::SshTunnelConfig;

/// 从本机扫出的一个 Navicat 连接候选
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavicatCandidate {
    /// Navicat 里的连接名
    pub source_name: String,
    /// "mysql" 或 "unsupported:xxx"（ConnectionType 非 MySQL 时）
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 解密出的明文密码；状态不是 plain 时为 None
    pub password: Option<String>,
    /// plain / master / unknown / empty
    pub password_status: String,
    pub database: Option<String>,
    /// Navicat 的 SSH 隧道配置（转成 DBFlow 结构；密码在 ssh_password）
    pub ssh: Option<SshTunnelConfig>,
    pub ssh_password: Option<String>,
    /// MacProfiles / WindowsRegistry / NcxFile
    pub origin: String,
}

/// 扫描本机 Navicat 安装的连接配置。没装 Navicat 时返回空列表。
pub fn scan_local() -> Vec<NavicatCandidate> {
    #[cfg(target_os = "macos")]
    {
        let files = macos::collect_ncx_files();
        ncx::candidates_from_files(&files, "MacProfiles")
    }
    #[cfg(windows)]
    {
        windows::scan_registry()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}
