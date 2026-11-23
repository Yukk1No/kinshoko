//! 备份后的清理：按保留策略删旧快照，再删没有快照引用的原文件。

use super::*;

impl BackupTarget {
    /// 按保留策略删掉旧快照，再删掉不再被任何快照引用的原文件。返回删掉的快照。
    ///
    /// 有完整快照读不了清单时，确认不了它引用哪些原文件，这次不删原文件。
    pub(super) fn prune(&self, root: &Path) -> Result<Vec<String>, BackupError> {
        let CompleteSnapshots {
            readable: manifests,
            unreadable,
        } = complete_snapshots(root)?;
        let stamps: Vec<Stamp> = manifests.iter().map(|(_, m)| m.created_at).collect();
        let keep = retention::keep(&stamps);
        let mut removed = Vec::new();
        let mut referenced = BTreeSet::new();
        for (i, (dir, m)) in manifests.iter().enumerate() {
            if keep.contains(&i) {
                for lib in &m.libraries {
                    referenced.extend(lib.originals.iter().map(|f| f.sha256.clone()));
                }
            } else {
                fs::remove_dir_all(dir)?;
                removed.push(m.id.clone());
            }
        }
        if unreadable.is_empty() {
            for shard in fs::read_dir(root.join(STORE))?.flatten() {
                let Ok(files) = fs::read_dir(shard.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().into_owned();
                    if !referenced.contains(&name) {
                        let _ = fs::remove_file(file.path());
                    }
                }
            }
        }
        removed.sort();
        Ok(removed)
    }
}
