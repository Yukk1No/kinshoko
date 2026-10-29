//! 本机 Eagle 找库：本地 API → 设置文件 → 有界磁盘扫描。来源始终只读。

use std::collections::HashSet;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

const MAX_JSON_BYTES: u64 = 5 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "$recycle.bin",
    "system volume information",
    "node_modules",
    ".git",
    "msocache",
    "recovery",
    "perflogs",
    "cache",
    "code cache",
    "gpucache",
    "blob_storage",
    "logs",
    "crashpad",
];

/// 找库的本机环境；测试显式指定环境，避免修改全进程 APPDATA。
pub struct EagleDiscoveryOptions {
    pub app_data: PathBuf,
    pub api_address: Option<SocketAddr>,
    pub scan_roots: Vec<PathBuf>,
    pub scan_limit: Duration,
}

impl Default for EagleDiscoveryOptions {
    fn default() -> Self {
        let mut scan_roots = Vec::new();
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            scan_roots.push(home.into());
        }
        if cfg!(windows) {
            scan_roots.extend(
                (b'A'..=b'Z')
                    .map(|drive| PathBuf::from(format!("{}:\\", drive as char)))
                    .filter(|p| p.is_dir()),
            );
        }
        Self {
            app_data: std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_default(),
            api_address: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 41595))),
            scan_roots,
            scan_limit: Duration::from_secs(40),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EagleDiscoveryMethod {
    Api,
    Settings,
    Scan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EagleLibraryCandidate {
    #[ts(type = "string")]
    pub path: PathBuf,
    pub name: String,
    pub items: u32,
    pub version: Option<String>,
    pub found_by: EagleDiscoveryMethod,
}

/// 优先用 API 和设置里的历史记录；都没有可读资料库时才扫描磁盘。
/// 按 images/ 下的条目数排序，最大的资料库排在最前；不读取 mtime.json。
pub fn discover_eagle_libraries(options: &EagleDiscoveryOptions) -> Vec<EagleLibraryCandidate> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    if let Some(address) = options.api_address {
        for path in from_api(address) {
            add_candidate(&path, EagleDiscoveryMethod::Api, &mut seen, &mut found);
        }
    }
    let settings = options.app_data.join("Eagle/Settings");
    let mut paths = Vec::new();
    read_settings(&settings, 0, &mut paths);
    for path in paths {
        add_candidate(&path, EagleDiscoveryMethod::Settings, &mut seen, &mut found);
    }
    if found.is_empty() {
        let deadline = Instant::now() + options.scan_limit;
        let mut visited = HashSet::new();
        for root in &options.scan_roots {
            scan(root, 0, deadline, &mut visited, &mut seen, &mut found);
        }
    }
    found.sort_by(|a, b| b.items.cmp(&a.items).then_with(|| a.path.cmp(&b.path)));
    found
}

fn from_api(address: SocketAddr) -> Vec<PathBuf> {
    let response = (|| {
        // 只问本机 Eagle：不走代理、不跟随重定向；非 2xx 状态由 ureq 作为错误返回。
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(2))
            .build();
        let response = agent
            .get(&format!("http://{address}/api/library/history"))
            .call()
            .ok()?;
        let mut raw = String::new();
        response
            .into_reader()
            .take(MAX_JSON_BYTES)
            .read_to_string(&mut raw)
            .ok()?;
        serde_json::from_str::<Value>(&raw).ok()
    })();
    response
        .and_then(|v| v.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect()
}

fn read_settings(path: &Path, depth: usize, paths: &mut Vec<PathBuf>) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    if meta.is_dir() {
        if depth >= 4 {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if !skip(&entry.path()) {
                    read_settings(&entry.path(), depth + 1, paths);
                }
            }
        }
    } else if meta.len() <= MAX_JSON_BYTES {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
            return;
        };
        fn strings(value: &Value, paths: &mut Vec<PathBuf>) {
            match value {
                Value::String(s)
                    if s.trim_end_matches(['/', '\\'])
                        .to_lowercase()
                        .ends_with(".library") =>
                {
                    paths.push(PathBuf::from(s))
                }
                Value::Array(values) => {
                    for value in values {
                        strings(value, paths);
                    }
                }
                Value::Object(values) => {
                    for value in values.values() {
                        strings(value, paths);
                    }
                }
                _ => {}
            }
        }
        strings(&value, paths);
    }
}

fn display_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(local) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path
}

fn add_candidate(
    path: &Path,
    method: EagleDiscoveryMethod,
    seen: &mut HashSet<String>,
    found: &mut Vec<EagleLibraryCandidate>,
) {
    if !path.join("images").is_dir() {
        return;
    }
    let Ok(raw) = std::fs::read_to_string(path.join("metadata.json")) else {
        return;
    };
    let Ok(meta) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return;
    };
    if !meta.is_object() {
        return;
    }
    let Ok(path) = std::fs::canonicalize(path) else {
        return;
    };
    let key = if cfg!(windows) {
        path.to_string_lossy().to_lowercase()
    } else {
        path.to_string_lossy().into_owned()
    };
    if !seen.insert(key) {
        return;
    }
    let items = std::fs::read_dir(path.join("images"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry.file_type().is_ok_and(|kind| kind.is_dir())
                        && entry
                            .path()
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("info"))
                })
                .count() as u32
        })
        .unwrap_or(0);
    found.push(EagleLibraryCandidate {
        name: path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: display_path(path),
        items,
        version: meta
            .get("applicationVersion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        found_by: method,
    });
}

fn skip(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| SKIP_DIRS.contains(&name.to_string_lossy().to_lowercase().as_str()))
}

fn scan(
    path: &Path,
    depth: usize,
    deadline: Instant,
    visited: &mut HashSet<PathBuf>,
    seen: &mut HashSet<String>,
    found: &mut Vec<EagleLibraryCandidate>,
) {
    if Instant::now() >= deadline || skip(path) {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return;
    }
    let Ok(key) = std::fs::canonicalize(path) else {
        return;
    };
    if !visited.insert(key) {
        return;
    }
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("library"))
    {
        add_candidate(path, EagleDiscoveryMethod::Scan, seen, found);
        return;
    }
    if depth >= 5 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if Instant::now() >= deadline {
                break;
            }
            scan(&entry.path(), depth + 1, deadline, visited, seen, found);
        }
    }
}
