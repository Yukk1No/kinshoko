//! 参考组自带的截图（#270）随快照走：备份时写进 `groups/<参考组 id>.captures/`，恢复时读回核对，
//! 往返检查核对恢复出的截图字节。

use super::*;
use crate::reference_groups::{CaptureFiles, GroupMember, MemberSource};

/// 快照里的一个参考组。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestGroup {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) captures: Vec<ManifestCapture>,
}

/// 快照里的一张组内截图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ManifestCapture {
    file: String,
    sha256: String,
}

fn dir(groups_dir: &Path, group_id: &str) -> PathBuf {
    groups_dir.join(format!("{group_id}.captures"))
}

/// 把参考组快照 `snapshot` 用到的组内截图写进快照目录 `groups_dir`。有截图读不到时报错。
pub(super) fn save(
    groups: &ReferenceGroups,
    group_id: &str,
    snapshot: &[u8],
    groups_dir: &Path,
) -> Result<Vec<ManifestCapture>, BackupError> {
    let files = groups.snapshot_captures(group_id, snapshot)?;
    if !files.is_empty() {
        fs::create_dir_all(dir(groups_dir, group_id))?;
    }
    files
        .iter()
        .map(|(file, bytes)| {
            write_synced(&dir(groups_dir, group_id).join(file), bytes)?;
            Ok(ManifestCapture {
                file: file.clone(),
                sha256: sha256(bytes),
            })
        })
        .collect()
}

/// 参考组 `group_id` 的快照连同它用到的组内截图共多少字节；截图每次都重新复制，不按哈希去重。
/// 快照读不到时为 `None`。
pub(super) fn size(groups: &ReferenceGroups, group_id: &str) -> Option<u64> {
    let snapshot = groups.snapshot(group_id).ok()?;
    let files = groups
        .snapshot_captures(group_id, &snapshot)
        .unwrap_or_default();
    Some(snapshot.len() as u64 + files.iter().map(|(_, b)| b.len() as u64).sum::<u64>())
}

/// 从快照目录 `groups_dir` 读回参考组 `group` 的组内截图，与清单记录的 SHA-256 核对。
pub(super) fn load(groups_dir: &Path, group: &ManifestGroup) -> Result<CaptureFiles, BackupError> {
    group
        .captures
        .iter()
        .map(|c| {
            let bytes = fs::read(dir(groups_dir, &group.id).join(&c.file))
                .ok()
                .filter(|b| sha256(b) == c.sha256)
                .ok_or_else(|| {
                    BackupError::incomplete(
                        crate::command_error::ErrorKind::SnapshotCapturesMismatch {
                            name: group.name.clone(),
                        },
                        format!("参考组“{}”的截图快照不符", group.name),
                    )
                })?;
            Ok((c.file.clone(), bytes))
        })
        .collect()
}

/// 往返检查：恢复出的组内截图成员 `member` 的截图与快照里的一致；不一致时给出原因。
pub(super) fn check(
    groups: &ReferenceGroups,
    restored_id: &str,
    member: &GroupMember,
    group: &ManifestGroup,
) -> Option<String> {
    let MemberSource::Capture { capture_file } = &member.source else {
        return None;
    };
    let expected = group.captures.iter().find(|c| &c.file == capture_file);
    let actual = groups
        .capture_path(restored_id, &member.id)
        .and_then(|p| fs::read(p).ok());
    match (expected, actual) {
        (Some(c), Some(bytes)) if sha256(&bytes) == c.sha256 => None,
        _ => Some(format!(
            "参考组“{}”的成员 {} 的截图与快照不一致",
            group.name, member.id
        )),
    }
}
