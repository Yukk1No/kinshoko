//! Eagle 导入来源 adapter：只读来源，枚举以 images/ 为准。

use std::path::{Path, PathBuf};

pub(super) fn is_library(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("library"))
        || (path.join("metadata.json").is_file() && path.join("images").is_dir())
}

pub(super) fn is_item(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("info"))
        && path
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "images"))
}

pub(super) fn collect(path: &Path) -> Result<Vec<PathBuf>, String> {
    let raw = std::fs::read_to_string(path.join("metadata.json")).map_err(|e| e.to_string())?;
    let _: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Eagle 库元数据无效：{e}"))?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(path.join("images")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() && is_item(&entry.path()) {
            items.push(entry.path());
        }
    }
    items.sort();
    Ok(items)
}

pub(super) fn original(path: &Path) -> Result<PathBuf, String> {
    let raw = std::fs::read_to_string(path.join("metadata.json")).map_err(|e| e.to_string())?;
    let item: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Eagle 条目元数据无效：{e}"))?;
    let component = |field: &str| {
        item[field]
            .as_str()
            .filter(|s| !s.is_empty() && !s.contains(['/', '\\', ':']) && *s != "." && *s != "..")
            .ok_or_else(|| format!("Eagle 条目的 {field} 缺失或无效"))
    };
    Ok(path.join(format!("{}.{}", component("name")?, component("ext")?)))
}
