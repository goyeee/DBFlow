//! Windows：读注册表 HKCU\Software\PremiumSoft\*\Servers\* 里的 Navicat 连接。
//! 本文件只在 windows 目标下编译（见 navicat/mod.rs 的 cfg）。

use crate::navicat::ncx::RawConnection;
use crate::navicat::NavicatCandidate;

use std::collections::HashMap;

use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub fn scan_registry() -> Vec<NavicatCandidate> {
    let mut out = Vec::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(premium) = hkcu.open_subkey("Software\\PremiumSoft") else {
        return out;
    };
    for product in premium.enum_keys().flatten() {
        // 形如 NavicatPremium / NavicatPremiumCC 等，其下有 Servers 子键
        let Ok(product_key) = premium.open_subkey(&product) else {
            continue;
        };
        let servers = product_key
            .open_subkey("Servers")
            .or_else(|_| premium.open_subkey(format!("{}\\Servers", product)));
        let Ok(servers) = servers else {
            continue;
        };
        for server in servers.enum_keys().flatten() {
            let Ok(sk) = servers.open_subkey(&server) else {
                continue;
            };
            let mut raw = RawConnection {
                attrs: read_values(&sk),
                ssh: None,
            };
            if let Ok(ssh_key) = sk.open_subkey("SSH") {
                raw.ssh = Some(read_values(&ssh_key));
            }
            // 连接名 = 子键名
            raw.attrs
                .entry("ConnectionName".to_string())
                .or_insert_with(|| server.clone());
            if let Some(c) = super::ncx::candidate_from_raw(&raw, "WindowsRegistry") {
                out.push(c);
            }
        }
    }
    out
}

fn read_values(key: &RegKey) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for name in key.enum_values().flatten().map(|(n, _)| n) {
        // Navicat 大多存 REG_SZ；数字/其他类型也尽量按字符串取
        if let Ok(v) = key.get_string_value(&name) {
            map.insert(name, v);
        }
    }
    map
}
