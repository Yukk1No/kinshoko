//! 备份目标里的文件：原图库、快照目录与清单。

use super::*;

pub(super) fn registered<'a>(
    sources: &'a BackupSources,
    item: &ScopeItem,
) -> Result<&'a RegisteredLibrary, CommandError> {
    sources
        .libraries
        .iter()
        .find(|l| l.id == item.id)
        .ok_or_else(|| {
            CommandError::new(
                ErrorKind::BackupLibraryNotRegistered,
                "本设备没有登记这个资料库",
            )
        })
}

/// 备份目标的原文件区里已有这份原文件，且大小与哈希都和记录相符。
pub(super) fn holds(stored: &Path, file: &OriginalFile) -> bool {
    fs::metadata(stored).is_ok_and(|m| m.len() == file.size)
        && library::hash_file(stored).is_ok_and(|got| got == file.sha256)
}

/// 复制进备份目标的原文件区：先写临时文件、核对哈希、落盘，再改名。
pub(super) fn store(source: &Path, target: &Path, sha: &str) -> Result<(), CommandError> {
    let dir = target.parent().expect("原文件区有上级目录");
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{sha}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = match library::copy_hashed(source, &tmp) {
        Ok(got) if got == sha => fs::rename(&tmp, target).map_err(CommandError::from),
        Ok(_) => Err(CommandError::new(
            ErrorKind::BackupOriginalChanged,
            "原图内容与资料库记录不符（可能被外部改动），这次备份不完整",
        )),
        Err(e) => Err(CommandError::new(
            ErrorKind::BackupOriginalUnreadable {
                detail: e.to_string(),
            },
            format!("读不到原图：{e}"),
        )),
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

/// 读得了清单的完整快照；列不出目录时当成没有快照。
pub(super) fn complete_manifests(root: &Path) -> Vec<(PathBuf, Manifest)> {
    complete_snapshots(root)
        .map(|snapshots| snapshots.readable)
        .unwrap_or_default()
}

/// 备份目标里的全部完整快照目录。
pub(super) struct CompleteSnapshots {
    pub readable: Vec<(PathBuf, Manifest)>,
    /// 读不了清单的快照目录：确认不了它们引用哪些原文件。
    pub unreadable: Vec<PathBuf>,
}

/// 列出全部完整快照目录；列不全目录时出错，不当成没有快照。
pub(super) fn complete_snapshots(root: &Path) -> std::io::Result<CompleteSnapshots> {
    let mut snapshots = CompleteSnapshots {
        readable: Vec::new(),
        unreadable: Vec::new(),
    };
    for entry in fs::read_dir(root.join(SNAPSHOTS))? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().ends_with(INCOMPLETE) {
            continue;
        }
        // 跟着目录链接走：恢复认链接过去的快照，这里也得读它的清单。
        match fs::metadata(entry.path()) {
            Ok(meta) if !meta.is_dir() => continue,
            Ok(_) => match read_manifest(&entry.path()) {
                Ok(m) => snapshots.readable.push((entry.path(), m)),
                Err(_) => snapshots.unreadable.push(entry.path()),
            },
            // 看不清是不是快照目录（比如链接指向的盘不在）：确认不了它引用哪些原文件。
            Err(_) => snapshots.unreadable.push(entry.path()),
        }
    }
    Ok(snapshots)
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
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}-{}",
        at.local_datetime().strftime("%Y%m%d-%H%M%S"),
        &tail[..6]
    )
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Reserve a free destination by creating its namesake in the batch's staging directory.
pub(super) fn reserve_library_dir(
    into: &Path,
    staging: &Path,
    name: impl Fn(Option<usize>) -> String,
) -> std::io::Result<(PathBuf, PathBuf)> {
    let mut number = None;
    let mut n = 2;
    loop {
        let clean: String = name(number)
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
                c if c.is_control() => '_',
                c => c,
            })
            .collect();
        let clean = clean.trim().trim_end_matches('.');
        let dest = into.join(clean);
        if !dest.try_exists()? {
            let stage = staging.join(clean);
            // Let the filesystem detect aliases (including Unicode case) within this batch.
            match fs::create_dir(&stage) {
                Ok(()) => return Ok((dest, stage)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        number = Some(n);
        n += 1;
    }
}
