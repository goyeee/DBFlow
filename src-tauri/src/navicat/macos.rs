//! macOS：扫描 ~/Library/Application Support 下 PremiumSoft* 目录里的
//! Navicat Profiles（*.ncx）。
use std::path::{Path, PathBuf};

/// 返回 (文件路径, 文件内容) 列表。没装 Navicat / 无配置时为空。
pub fn collect_ncx_files() -> Vec<(PathBuf, String)> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let app_support = Path::new(&home).join("Library/Application Support");
    let Ok(entries) = std::fs::read_dir(&app_support) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("PremiumSoft") {
            walk_ncx(&entry.path(), 0, &mut files);
        }
    }
    files
}

/// 递归收集 *.ncx（限深 10，忽略不可读目录）
fn walk_ncx(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, String)>) {
    if depth > 10 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_ncx(&path, depth + 1, out);
        } else if path.extension().map(|e| e == "ncx").unwrap_or(false) {
            match std::fs::read_to_string(&path) {
                Ok(xml) => out.push((path, xml)),
                Err(e) => tracing::debug!("读取 {:?} 失败: {}", path, e),
            }
        }
    }
}
