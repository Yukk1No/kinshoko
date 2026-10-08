//! Recoverable publication of one content-restore batch. Never owns pre-existing content.
use super::target::{BackupError, RestoredLibrary, write_synced};
use crate::Library;
use crate::reference_groups::{GroupError, ReferenceGroup, ReferenceGroups};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

static RESTORE_GATE: Mutex<()> = Mutex::new(());
pub(super) fn lock() -> MutexGuard<'static, ()> {
    RESTORE_GATE.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    id: String,
    backup_id: String,
    stage: PathBuf,
    libraries: Vec<OwnedLibrary>,
    groups: Vec<OwnedGroup>,
}
#[derive(Serialize, Deserialize)]
struct OwnedLibrary {
    id: String,
    old_id: String,
    root: PathBuf,
}
#[derive(Serialize, Deserialize)]
struct OwnedGroup {
    id: String,
    old_id: String,
}

pub(super) struct RestoreBatch<'a> {
    journal: Journal,
    path: PathBuf,
    groups: &'a ReferenceGroups,
    finished: bool,
}
impl<'a> RestoreBatch<'a> {
    pub(super) fn new(
        into: &Path,
        groups: &'a ReferenceGroups,
        backup_id: &str,
    ) -> Result<Self, BackupError> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let stage = std::path::absolute(into)?.join(format!(".kinshoko-restore-{id}.incomplete"));
        fs::create_dir(&stage)?;
        write_synced(&stage.join("owner"), id.as_bytes())?;
        let dir = groups.restore_journal_dir();
        fs::create_dir_all(&dir)?;
        let batch = Self {
            journal: Journal {
                version: 1,
                id: id.clone(),
                backup_id: backup_id.into(),
                stage,
                libraries: Vec::new(),
                groups: Vec::new(),
            },
            path: dir.join(format!("{id}.json")),
            groups,
            finished: false,
        };
        batch.save()?;
        Ok(batch)
    }
    pub(super) fn stage(&self) -> &Path {
        &self.journal.stage
    }
    pub(super) fn prepare(
        &mut self,
        libraries: &[RestoredLibrary],
        groups: &[ReferenceGroup],
    ) -> Result<(), BackupError> {
        self.journal.libraries = libraries
            .iter()
            .map(|restored| OwnedLibrary {
                id: restored.library.id.clone(),
                old_id: restored.old_id.clone(),
                root: restored.library.root.clone(),
            })
            .collect();
        self.journal.groups = groups
            .iter()
            .map(|group| OwnedGroup {
                id: group.id.clone(),
                old_id: group
                    .restored_from
                    .as_ref()
                    .expect("restored group has provenance")
                    .group_id
                    .clone(),
            })
            .collect();
        self.save()
    }
    fn save(&self) -> Result<(), BackupError> {
        let bytes = serde_json::to_vec_pretty(&self.journal).map_err(std::io::Error::other)?;
        let temp = self.path.with_extension("json.incomplete");
        write_synced(&temp, &bytes)?;
        fs::rename(temp, &self.path)?;
        Ok(())
    }
    pub(super) fn finish(mut self) -> Result<(), BackupError> {
        fs::remove_dir_all(&self.journal.stage)?;
        fs::remove_file(&self.path)?;
        self.finished = true;
        Ok(())
    }
    pub(super) fn rollback(&mut self) -> Result<(), BackupError> {
        rollback(&self.journal, self.groups)?;
        fs::remove_file(&self.path)?;
        self.finished = true;
        Ok(())
    }
}
impl Drop for RestoreBatch<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.rollback();
        }
    }
}

/// Recover unfinished content publication after process interruption. This rolls back only the
/// batch's recorded new identities. Call on app startup and before retrying a content restore.
pub fn recover_restores(groups: &ReferenceGroups) -> Result<u32, BackupError> {
    let _gate = lock();
    recover(groups)
}
pub(super) fn recover(groups: &ReferenceGroups) -> Result<u32, BackupError> {
    let dir = groups.restore_journal_dir();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut recovered = 0;
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let journal: Journal = serde_json::from_slice(&fs::read(&path)?)
            .map_err(|e| BackupError::Incomplete(format!("内容恢复记录损坏：{e}")))?;
        if path.file_stem().and_then(|s| s.to_str()) != Some(journal.id.as_str()) {
            return Err(BackupError::Incomplete("内容恢复记录身份不符".into()));
        }
        rollback(&journal, groups)?;
        fs::remove_file(path)?;
        recovered += 1;
    }
    Ok(recovered)
}
fn rollback(journal: &Journal, groups: &ReferenceGroups) -> Result<(), BackupError> {
    if journal.version != 1
        || journal.id.len() != 32
        || !journal.id.chars().all(|c| c.is_ascii_hexdigit())
        || !journal.stage.is_absolute()
        || journal.stage.file_name().and_then(|s| s.to_str())
            != Some(format!(".kinshoko-restore-{}.incomplete", journal.id).as_str())
    {
        return Err(BackupError::Incomplete("内容恢复记录的位置无效".into()));
    }
    if journal.stage.exists() && fs::read(journal.stage.join("owner"))? != journal.id.as_bytes() {
        return Err(BackupError::Incomplete(
            "内容恢复暂存位置不属于本批次".into(),
        ));
    }
    // Validate all identities before deleting anything, including after a user moved/replaced a path.
    for restored in &journal.libraries {
        let info = restored;
        if info.root.parent() != journal.stage.parent() || info.root == journal.stage {
            return Err(BackupError::Incomplete("内容恢复结果的位置无效".into()));
        }
        if !info.root.exists() {
            continue;
        }
        let library = Library::open_read_only(&info.root, &info.id)?;
        if !library
            .restore_provenance()?
            .iter()
            .any(|p| p.old_library_id == restored.old_id && p.backup_id == journal.backup_id)
        {
            return Err(BackupError::Incomplete(
                "内容恢复结果身份不符，不清理现有资料库".into(),
            ));
        }
    }
    for owned in &journal.groups {
        match groups.get(&owned.id) {
            Ok(group)
                if group.restored_from.as_ref().is_some_and(|p| {
                    p.backup_id == journal.backup_id && p.group_id == owned.old_id
                }) => {}
            Err(GroupError::UnknownGroup) => {}
            Ok(_) => {
                return Err(BackupError::Incomplete(
                    "内容恢复参考组身份不符，不清理现有参考组".into(),
                ));
            }
            Err(e) => return Err(e.into()),
        }
    }
    for owned in &journal.groups {
        match groups.delete(&owned.id) {
            Ok(()) | Err(GroupError::UnknownGroup) => {}
            Err(e) => return Err(e.into()),
        }
    }
    for restored in &journal.libraries {
        if restored.root.exists() {
            fs::remove_dir_all(&restored.root)?;
        }
    }
    if journal.stage.exists() {
        fs::remove_dir_all(&journal.stage)?;
    }
    Ok(())
}
