//! .ncx 文件（Navicat 连接配置 XML）解析 → NavicatCandidate。
//! 同时兼容两种形态：
//! - Navicat 导出的连接文件（多个 <Connection> 节点）
//! - macOS Profiles 目录下的单连接 .ncx（一个 <Connection> + 内嵌 <Ssh>）
use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::decrypt::{decrypt_password, Decrypted};
use super::NavicatCandidate;
use crate::config::model::{SshAuth, SshTunnelConfig};

/// 一个 <Connection> 节点的原始属性
#[derive(Debug, Default, Clone)]
pub struct RawConnection {
    pub attrs: HashMap<String, String>,
    pub ssh: Option<HashMap<String, String>>,
}

/// 解析 XML 里的所有连接节点（宽容模式：坏节点跳过，不整体失败）
pub fn parse_ncx(xml: &str) -> Vec<RawConnection> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut out: Vec<RawConnection> = Vec::new();
    let mut current: Option<RawConnection> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let tag = tag_name(e.name());
                if tag == "Connection" {
                    current = Some(RawConnection {
                        attrs: attrs_of(&e),
                        ssh: None,
                    });
                } else if tag == "Ssh" {
                    if let Some(cur) = current.as_mut() {
                        cur.ssh = Some(attrs_of(&e));
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = tag_name(e.name());
                if tag == "Connection" {
                    // 自闭合的连接节点直接完成
                    out.push(RawConnection {
                        attrs: attrs_of(&e),
                        ssh: None,
                    });
                } else if tag == "Ssh" {
                    if let Some(cur) = current.as_mut() {
                        cur.ssh = Some(attrs_of(&e));
                    }
                }
            }
            Ok(Event::End(e)) => {
                if tag_name(e.name()) == "Connection" {
                    if let Some(cur) = current.take() {
                        out.push(cur);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                tracing::debug!("ncx 解析中断: {}", e);
                break;
            }
            _ => {}
        }
    }
    out
}

fn tag_name(qname: quick_xml::name::QName) -> String {
    String::from_utf8_lossy(qname.as_ref()).to_string()
}

#[allow(deprecated)] // unescape_value 足够用，normalized_value 需要 XML 版本参数
fn attrs_of(e: &quick_xml::events::BytesStart) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for attr in e.attributes().with_checks(false) {
        let Ok(attr) = attr else { continue };
        let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
        // unescape 处理 &amp; 等实体；失败则退回原文
        let value = attr
            .unescape_value()
            .map(|v| v.to_string())
            .unwrap_or_else(|_| String::from_utf8_lossy(attr.value.as_ref()).to_string());
        map.insert(key, value);
    }
    map
}

/// 批量文件 → 候选列表
pub fn candidates_from_files(files: &[(impl AsRef<Path>, String)], origin: &str) -> Vec<NavicatCandidate> {
    let mut out = Vec::new();
    for (path, xml) in files {
        for raw in parse_ncx(xml) {
            // 记录来源文件便于排查
            tracing::debug!(file = ?path.as_ref(), conn = ?raw.attrs.get("ConnectionName"), "ncx 节点");
            if let Some(c) = candidate_from_raw(&raw, origin) {
                out.push(c);
            }
        }
    }
    out
}

/// 单个 XML 字符串 → 候选列表
pub fn candidates_from_str(xml: &str, origin: &str) -> Vec<NavicatCandidate> {
    parse_ncx(xml)
        .iter()
        .filter_map(|raw| candidate_from_raw(raw, origin))
        .collect()
}

pub(crate) fn candidate_from_raw(raw: &RawConnection, origin: &str) -> Option<NavicatCandidate> {
    let get = |k: &str| raw.attrs.get(k).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let conn_type = get("ConnectionType").unwrap_or_else(|| "MySQL".to_string());
    // Navicat 里 MySQL 的 ConnectionType 就是 "MySQL"（部分版本带后缀）
    let kind = if conn_type.to_ascii_uppercase().starts_with("MYSQL") {
        "mysql".to_string()
    } else {
        format!("unsupported:{}", conn_type)
    };

    let host = get("Host")?;
    let port: u16 = get("Port").and_then(|p| p.parse().ok()).unwrap_or(3306);
    let user = get("UserName").unwrap_or_else(|| "root".to_string());

    let name = get("ConnectionName")
        .or_else(|| get("Name"))
        .unwrap_or_else(|| format!("{}:{}", host, port));

    let (password, password_status) = match get("Password").as_deref() {
        None | Some("") => (None, "empty".to_string()),
        Some(enc) => match decrypt_password(enc) {
            Decrypted::Plain(p) => (Some(p), "plain".to_string()),
            Decrypted::MasterPassword => (None, "master".to_string()),
            Decrypted::Unknown => (None, "unknown".to_string()),
        },
    };

    let database = get("Database").or_else(|| get("InitialDatabase"));

    // SSH：Method 0=密码 1=私钥 2=默认/agent（2 视为密码方式）
    let ssh = raw.ssh.as_ref().and_then(|s| {
        let sget = |k: &str| s.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let ssh_host = sget("Host")?;
        let ssh_port: u16 = sget("Port").and_then(|p| p.parse().ok()).unwrap_or(22);
        let ssh_user = sget("UserName")?;
        let auth = if sget("Method").as_deref() == Some("1") || s.get("PrivateKey").is_some() {
            SshAuth::PrivateKey {
                key_path: sget("PrivateKey").unwrap_or_default(),
            }
        } else {
            SshAuth::Password
        };
        Some(SshTunnelConfig {
            host: ssh_host,
            port: ssh_port,
            user: ssh_user,
            auth,
            target_host_override: None,
        })
    });

    let ssh_password = raw.ssh.as_ref().and_then(|s| {
        let enc = s.get("Password").map(|v| v.trim().to_string()).filter(|v| !v.is_empty())?;
        match decrypt_password(&enc) {
            Decrypted::Plain(p) if !p.is_empty() => Some(p),
            _ => None,
        }
    });

    Some(NavicatCandidate {
        source_name: name,
        kind,
        host,
        port,
        user,
        password,
        password_status,
        database,
        ssh,
        ssh_password,
        origin: origin.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ncx_export_style() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <Connections>
          <Connection ConnectionType="MySQL" ConnectionName="生产库" Host="192.168.1.10" Port="3306"
                      UserName="root" Password="833E4AB8B39692208F5EC7AEDEAAEA9E" Database="db_shop">
            <Ssh Host="jump.example.com" Port="22" UserName="deploy" Method="0" Password="CCCC"/>
          </Connection>
          <Connection ConnectionType="PostgreSQL" ConnectionName="PG" Host="pg.example.com" Port="5432" UserName="postgres"/>
        </Connections>"#;
        let raws = parse_ncx(xml);
        assert_eq!(raws.len(), 2);
        let c = candidates_from_str(xml, "NcxFile");
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].source_name, "生产库");
        assert_eq!(c[0].kind, "mysql");
        assert_eq!(c[0].port, 3306);
        assert!(c[0].ssh.is_some());
        assert_eq!(c[0].ssh.as_ref().unwrap().host, "jump.example.com");
        assert_eq!(c[1].kind, "unsupported:PostgreSQL");
    }

    #[test]
    fn parse_self_closing_connection() {
        let xml = r#"<Connections>
          <Connection ConnectionType="MySQL" ConnectionName="本地" Host="127.0.0.1" Port="3306" UserName="root"/>
        </Connections>"#;
        let c = candidates_from_str(xml, "MacProfiles");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].source_name, "本地");
        assert_eq!(c[0].password_status, "empty");
        assert!(c[0].ssh.is_none());
    }
}
