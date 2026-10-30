//! 备份目标里的文件：原图库、快照目录与清单。

use super::*;

pub(super) fn registered<'a>(
    sources: &'a BackupSources,
    item: &ScopeItem,
) -> Result<&'a RegisteredLibrary, String> {
    sources
        .libraries
        .iter()
        .find(|l| l.id == item.id)
        .ok_or_else(|| "本设备没有登记这个资料库".to_owned())
}

/// 复制进备份目标的原文件区：先写临时文件、核对哈希、落盘，再改名。
pub(super) fn store(source: &Path, target: &Path, sha: &str) -> Result<(), String> {
    let dir = target.parent().expect("原文件区有上级目录");
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".{sha}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = match library::copy_hashed(source, &tmp) {
        Ok(got) if got == sha => fs::rename(&tmp, target).map_err(|e| e.to_string()),
        Ok(_) => Err("原图内容与资料库记录不符（可能被外部改动），这次备份不完整".into()),
        Err(e) => Err(format!("读不到原图：{e}")),
    };
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub(super) fn remove_incomplete(snapshots: &Path) {
    if let Ok(entries) = fs::read_dir(snapshots) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(INCOMPLETE) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

pub(super) fn complete_manifests(root: &Path) -> Vec<(PathBuf, Manifest)> {
    let Ok(entries) = fs::read_dir(root.join(SNAPSHOTS)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().ends_with(INCOMPLETE))
        .filter_map(|e| read_manifest(&e.path()).ok().map(|m| (e.path(), m)))
        .collect()
}

pub(super) fn read_manifest(dir: &Path) -> Result<Manifest, CommandError> {
    let bytes = fs::read(dir.join(MANIFEST)).map_err(|e| {
        CommandError::new(
            ErrorKind::ManifestUnreadable {
                detail: e.to_string(),
            },
            format!("读不到清单：{e}"),
        )
    })?;
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| {
        CommandError::new(
            ErrorKind::ManifestDamaged {
                detail: e.to_string(),
            },
            format!("清单已损坏：{e}"),
        )
    })?;
    if m.format != FORMAT {
        return Err(CommandError::new(
            ErrorKind::NotABackup,
            "不是 Kinshoko 备份",
        ));
    }
    if m.format_version > FORMAT_VERSION {
        return Err(CommandError::new(
            ErrorKind::BackupFromNewerVersion {
                version: m.format_version,
            },
            format!(
                "由更新版本的 Kinshoko 写成（格式版本 {}）",
                m.format_version
            ),
        ));
    }
    for lib in &m.libraries {
        if !valid_id(&lib.id)
            || lib.database_key.as_os_str().is_empty()
            || !lib
                .database_key
                .components()
                .all(|p| matches!(p, std::path::Component::Normal(_)))
        {
            return Err(CommandError::new(
                ErrorKind::SnapshotDatabaseKey,
                "数据库快照文件键无效",
            ));
        }
    }
    Ok(m)
}

pub(in crate::backup) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(super) fn snapshot_id(at: Stamp) -> String {
    let (y, mo, d, h, mi, s) = at.local_parts();
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{}", &tail[..6])
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `into` 下以 `name` 命名、还不存在的文件夹；重名时加序号。
pub(super) fn unique_dir(into: &Path, name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let clean = clean.trim().trim_end_matches('.').to_owned();
    let mut candidate = into.join(&clean);
    let mut n = 2;
    while candidate.exists() {
        candidate = into.join(format!("{clean} {n}"));
        n += 1;
    }
    candidate
}
