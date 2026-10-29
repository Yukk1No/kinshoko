//! 备份目标对外的错误、进度与报告。

use super::*;

/// 备份与恢复的错误。`Display` 是给画师看的中文说明。
#[derive(Debug)]
pub enum BackupError {
    /// 备份目标不在（移动盘没插、目录被删）。
    TargetUnavailable(PathBuf),
    /// 没有这个快照。
    UnknownSnapshot,
    /// 快照没有完成或已损坏，不能恢复。
    Incomplete(String),
    Io(std::io::Error),
    Library(library::Error),
    Group(GroupError),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::TargetUnavailable(p) => write!(
                f,
                "备份目标不在：{}。请接上移动盘或重新选择备份目录，下次会再试",
                p.display()
            ),
            BackupError::UnknownSnapshot => write!(f, "备份目标里没有这个快照"),
            BackupError::Incomplete(why) => write!(f, "这个快照不完整或已损坏，不能恢复：{why}"),
            BackupError::Io(e) => write!(f, "读写备份失败：{e}"),
            BackupError::Library(e) => e.fmt(f),
            BackupError::Group(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::Io(e)
    }
}

impl From<library::Error> for BackupError {
    fn from(e: library::Error) -> Self {
        BackupError::Library(e)
    }
}

impl From<GroupError> for BackupError {
    fn from(e: GroupError) -> Self {
        BackupError::Group(e)
    }
}

/// 备份读取的来源：本设备的资料库登记与参考组。
pub struct BackupSources<'a> {
    pub libraries: &'a [RegisteredLibrary],
    pub groups: &'a ReferenceGroups,
}

/// 备份进度：已处理的原文件数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupProgress {
    pub done: u32,
    pub total: u32,
}

/// 这次没能备份的资料库（例如所在的移动盘没插）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkippedLibrary {
    pub library: ScopeItem,
    pub reason: String,
}

/// 一次备份的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupReport {
    pub snapshot_id: String,
    /// 快照完整：有问题时留在 `.incomplete`，不能用来恢复。
    pub complete: bool,
    /// 这次新复制的原文件。
    pub copied: u32,
    #[ts(type = "number")]
    pub copied_bytes: u64,
    /// 备份目标里已有、直接引用的原文件。
    pub reused: u32,
    pub skipped: Vec<SkippedLibrary>,
    pub problems: Vec<String>,
    /// 按保留策略删掉的旧快照。
    pub removed_snapshots: Vec<String>,
}

/// 执行前的容量估计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackupEstimate {
    /// 范围内的全部内容（数据库、原文件、参考组）。
    #[ts(type = "number")]
    pub total_bytes: u64,
    /// 这次需要新写入备份目标的量（备份目标里已有的原文件不再复制）。
    #[ts(type = "number")]
    pub new_bytes: u64,
    pub originals: u32,
    pub new_originals: u32,
    /// 现在读不到的资料库。
    pub unavailable: Vec<SkippedLibrary>,
}

/// 备份目标里的一个完整快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotSummary {
    pub id: String,
    pub created_at: Stamp,
    pub libraries: Vec<ScopeItem>,
    pub groups: Vec<ScopeItem>,
    pub skipped: Vec<SkippedLibrary>,
}

/// 恢复出的资料库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoredLibrary {
    pub old_id: String,
    pub library: LibraryInfo,
}

/// 恢复出的参考组。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoredGroup {
    pub old_id: String,
    pub id: String,
    pub name: String,
}

/// 往返检查的一项。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CheckPart {
    pub checked: u32,
    pub problems: Vec<String>,
}

/// 恢复后的往返检查：原图哈希、整理信息、参考组。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RoundTripCheck {
    pub originals: CheckPart,
    pub curation: CheckPart,
    pub groups: CheckPart,
}

impl RoundTripCheck {
    pub fn passed(&self) -> bool {
        self.originals.problems.is_empty()
            && self.curation.problems.is_empty()
            && self.groups.problems.is_empty()
    }
}

/// 一次恢复的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoreReport {
    pub snapshot_id: String,
    pub libraries: Vec<RestoredLibrary>,
    pub groups: Vec<RestoredGroup>,
    pub check: RoundTripCheck,
}
