//! 交给界面的错误（#355）：错误代码＋参数，文字由前端按界面语言取。
//!
//! 命令层返回 [`CommandError`]，不再把错误压成中文句子；前端按 `code` 判断错误种类、取对应文案。
//! 领域里各错误类型的 `Display` 仍是中文，只用于日志与还没有错误代码的地方。

use std::fmt;
use std::path::Path;

use serde::Serialize;
use ts_rs::TS;

use crate::backup::BackupError;
use crate::desktop::{CaptureError, HistoryError, PinError};
use crate::reference_groups::{GroupError, UnavailableReason};
use crate::tag_catalog::CatalogError;
use crate::{
    DeviceLibraryError, SettingsError, ShortcutAction, ShortcutError, UiScaleError, WriterWaitError,
    library,
};

/// 命令失败的原因。`code` 决定文案，其余字段是文案里的参数。
///
/// `detail` 是系统或底层库给出的原文（例如磁盘错误），按原样附在文案后面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[ts(export)]
pub enum CommandError {
    /// 还没有错误代码的错误：`message` 按原样显示。
    Message { message: String },

    // 资料库（`library::Error`）。
    InvalidLibraryName,
    TagDefinitionsNotSaved { reason: String },
    NotEmpty { path: String },
    NotALibrary { path: String },
    UnknownImage,
    SourceChanged,
    UnknownFolder,
    FolderCycle,
    FolderReceivingImport,
    InvalidCursor,
    CursorExpired,
    InvalidDisplaySize,
    UnknownTag,
    UnknownTagGroup,
    InvalidTagName,
    AmbiguousTag { name: String },
    DuplicateTagName { name: String },
    ExternalTaken { name: String },
    SameTag,
    UnknownEagleSource,
    EagleLocationTaken,
    LensChanged,
    OutdatedLibrary,
    PackageImage { reason: String },
    MergeTargetGone,
    NamespaceGroup,
    NotInTrash,
    DeletePreviewStale,
    ReferenceGroupsUnchecked { reason: String },
    Io { detail: String },
    Database { detail: String },
    Migration { detail: String },
    ImageDecode { detail: String },
    Undecodable { detail: String },
    OriginalMissing { path: String },
    ClipboardImage { reason: String },

    // 本设备的资料库登记（`DeviceLibraryError`、`WriterWaitError`）。
    Registry { detail: String },
    UnknownLibrary,
    StaleLibrary,
    IdentityChanged { root: String },
    LibraryUnavailable { root: String, reason: String },
    /// 这些资料库的导入一直没有收尾，整理没有执行。
    OrganizeTimedOut { libraries: Vec<String> },

    // 统一标签目录（`CatalogError`）。
    CatalogIo { detail: String },
    CatalogStorage { detail: String },
    CatalogData { detail: String },
    CatalogInvalidDefinition { reason: String },
    CatalogInvalidGroupMembers,
    CatalogUnknownGroup,
    CatalogUnknownTag,
    CatalogUnknownMapping,
    CatalogNamespaceMismatch,
    CatalogInvalidName,
    CatalogStaleApproxConflict,
    CatalogStaleNameMigration,
    CatalogIncompleteNameMigration,
    CatalogUnsupportedFormat,

    // 参考组（`GroupError`）。
    GroupIo { detail: String },
    UnknownGroup,
    InvalidGroupName,
    GroupNoMembers,
    GroupUnsupportedVersion { version: u32 },
    GroupInvalid { reason: String },
    GroupMembersUnavailable { members: Vec<String> },
    NotAPackage,
    PackageDamaged { reason: String },

    // 备份（`BackupError`）。
    BackupTargetUnavailable { path: String },
    UnknownSnapshot,
    SnapshotIncomplete { reason: String },
    BackupIo { detail: String },

    // 设置、快捷键与界面缩放。
    SettingsIo { detail: String },
    ShortcutUsedBy { action: ShortcutAction },
    ShortcutUnavailable { reason: String },
    UiScaleUnsupported { percent: u16 },
    UiScaleIo { detail: String },

    // 截图与钉图（`CaptureError`、`HistoryError`、`PinError`）。
    EmptySelection,
    CaptureSourceUnavailable { reason: UnavailableReason },
    CaptureSourceChanged,
    CaptureSealed,
    CapturePixels { detail: String },
    CaptureUnknown,
    CollectFailed { reason: String },
    CaptureIo { detail: String },
    CaptureSave { detail: String },
    CropOutsideImage,
}

impl CommandError {
    /// 还没有错误代码的错误，按原样显示 `message`。
    pub fn message(message: impl fmt::Display) -> Self {
        CommandError::Message {
            message: message.to_string(),
        }
    }
}

fn path(p: &Path) -> String {
    p.display().to_string()
}

/// 日志里的写法：错误代码与参数（JSON）。给画师看的文字由前端取。
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandError::Message { message } => f.write_str(message),
            other => match serde_json::to_string(other) {
                Ok(json) => f.write_str(&json),
                Err(_) => write!(f, "{other:?}"),
            },
        }
    }
}

impl std::error::Error for CommandError {}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        CommandError::Message { message }
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        CommandError::message(message)
    }
}

impl From<library::Error> for CommandError {
    fn from(e: library::Error) -> Self {
        use library::Error as E;
        match e {
            E::InvalidName => CommandError::InvalidLibraryName,
            E::TagDefinitions(reason) => CommandError::TagDefinitionsNotSaved { reason },
            E::NotEmpty(p) => CommandError::NotEmpty { path: path(&p) },
            E::NotALibrary(p) => CommandError::NotALibrary { path: path(&p) },
            E::UnknownImage => CommandError::UnknownImage,
            E::SourceChanged => CommandError::SourceChanged,
            E::UnknownFolder => CommandError::UnknownFolder,
            E::FolderCycle => CommandError::FolderCycle,
            E::FolderReceivingImport => CommandError::FolderReceivingImport,
            E::InvalidCursor => CommandError::InvalidCursor,
            E::CursorExpired => CommandError::CursorExpired,
            E::InvalidDisplaySize => CommandError::InvalidDisplaySize,
            E::UnknownTag => CommandError::UnknownTag,
            E::UnknownTagGroup => CommandError::UnknownTagGroup,
            E::InvalidTagName => CommandError::InvalidTagName,
            E::AmbiguousTag(name) => CommandError::AmbiguousTag { name },
            E::DuplicateTagName(name) => CommandError::DuplicateTagName { name },
            E::ExternalTaken(name) => CommandError::ExternalTaken { name },
            E::NamespaceGroup => CommandError::NamespaceGroup,
            E::SameTag => CommandError::SameTag,
            E::UnknownEagleSource => CommandError::UnknownEagleSource,
            E::EagleLocationTaken => CommandError::EagleLocationTaken,
            E::LensChanged => CommandError::LensChanged,
            E::OutdatedLibrary => CommandError::OutdatedLibrary,
            E::PackageImage(reason) => CommandError::PackageImage { reason },
            E::MergeTargetGone => CommandError::MergeTargetGone,
            E::NotInTrash => CommandError::NotInTrash,
            E::DeletePreviewStale => CommandError::DeletePreviewStale,
            E::ReferenceGroups(reason) => CommandError::ReferenceGroupsUnchecked { reason },
            E::Io(e) => CommandError::Io {
                detail: e.to_string(),
            },
            E::Db(e) => CommandError::Database {
                detail: e.to_string(),
            },
            E::Migration(e) => CommandError::Migration {
                detail: e.to_string(),
            },
            E::Image(e) => CommandError::ImageDecode {
                detail: e.to_string(),
            },
            E::Undecodable(detail) => CommandError::Undecodable { detail },
            E::OriginalMissing(p) => CommandError::OriginalMissing { path: path(&p) },
            E::ClipboardImage(reason) => CommandError::ClipboardImage { reason },
        }
    }
}

impl From<DeviceLibraryError> for CommandError {
    fn from(e: DeviceLibraryError) -> Self {
        match e {
            DeviceLibraryError::Registry(e) => CommandError::Registry {
                detail: e.to_string(),
            },
            DeviceLibraryError::Library(e) => e.into(),
            DeviceLibraryError::UnknownLibrary => CommandError::UnknownLibrary,
            DeviceLibraryError::StaleLibrary => CommandError::StaleLibrary,
            DeviceLibraryError::IdentityChanged { root } => CommandError::IdentityChanged {
                root: path(&root),
            },
            DeviceLibraryError::Unavailable { root, reason } => CommandError::LibraryUnavailable {
                root: path(&root),
                reason,
            },
        }
    }
}

impl<E: Into<CommandError>> From<WriterWaitError<E>> for CommandError {
    fn from(e: WriterWaitError<E>) -> Self {
        match e {
            WriterWaitError::Request(e) => e.into(),
            WriterWaitError::TimedOut(notice) => CommandError::OrganizeTimedOut {
                libraries: notice.finishing,
            },
        }
    }
}

impl From<CatalogError> for CommandError {
    fn from(e: CatalogError) -> Self {
        match e {
            CatalogError::Io(e) => CommandError::CatalogIo {
                detail: e.to_string(),
            },
            CatalogError::Storage(e) => CommandError::CatalogStorage {
                detail: e.to_string(),
            },
            CatalogError::Data(e) => CommandError::CatalogData {
                detail: e.to_string(),
            },
            CatalogError::Library(e) => e.into(),
            CatalogError::UnknownTag => CommandError::CatalogUnknownTag,
            CatalogError::InvalidDefinition(reason) => {
                CommandError::CatalogInvalidDefinition { reason }
            }
            CatalogError::UnknownGroup => CommandError::CatalogUnknownGroup,
            CatalogError::InvalidGroupMembers => CommandError::CatalogInvalidGroupMembers,
            CatalogError::UnknownMapping => CommandError::CatalogUnknownMapping,
            CatalogError::NamespaceMismatch => CommandError::CatalogNamespaceMismatch,
            CatalogError::UnsupportedFormat => CommandError::CatalogUnsupportedFormat,
            CatalogError::InvalidName => CommandError::CatalogInvalidName,
            CatalogError::StaleNameMigration => CommandError::CatalogStaleNameMigration,
            CatalogError::StaleApproxConflict => CommandError::CatalogStaleApproxConflict,
            CatalogError::IncompleteNameMigration => CommandError::CatalogIncompleteNameMigration,
        }
    }
}

impl From<GroupError> for CommandError {
    fn from(e: GroupError) -> Self {
        match e {
            GroupError::Io(detail) => CommandError::GroupIo { detail },
            GroupError::UnknownGroup => CommandError::UnknownGroup,
            GroupError::InvalidName => CommandError::InvalidGroupName,
            GroupError::NoMembers => CommandError::GroupNoMembers,
            GroupError::UnsupportedVersion(version) => {
                CommandError::GroupUnsupportedVersion { version }
            }
            GroupError::Invalid(reason) => CommandError::GroupInvalid { reason },
            GroupError::MembersUnavailable(members) => {
                CommandError::GroupMembersUnavailable { members }
            }
            GroupError::NotAPackage => CommandError::NotAPackage,
            GroupError::PackageDamaged(reason) => CommandError::PackageDamaged { reason },
            GroupError::Library(message) => CommandError::Message { message },
        }
    }
}

impl From<BackupError> for CommandError {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::TargetUnavailable(p) => {
                CommandError::BackupTargetUnavailable { path: path(&p) }
            }
            BackupError::UnknownSnapshot => CommandError::UnknownSnapshot,
            BackupError::Incomplete(reason) => CommandError::SnapshotIncomplete { reason },
            BackupError::Io(e) => CommandError::BackupIo {
                detail: e.to_string(),
            },
            BackupError::Library(e) => e.into(),
            BackupError::Group(e) => e.into(),
        }
    }
}

impl From<SettingsError> for CommandError {
    fn from(e: SettingsError) -> Self {
        match e {
            SettingsError::Io(e) => CommandError::SettingsIo {
                detail: e.to_string(),
            },
            SettingsError::Invalid(why) => CommandError::message(why),
        }
    }
}

impl From<ShortcutError> for CommandError {
    fn from(e: ShortcutError) -> Self {
        match e {
            ShortcutError::Invalid(why) => CommandError::message(why),
            ShortcutError::UsedBy(action) => CommandError::ShortcutUsedBy { action },
            ShortcutError::Unavailable(reason) => CommandError::ShortcutUnavailable { reason },
            ShortcutError::Settings(e) => e.into(),
        }
    }
}

impl From<UiScaleError> for CommandError {
    fn from(e: UiScaleError) -> Self {
        match e {
            UiScaleError::Unsupported(percent) => CommandError::UiScaleUnsupported { percent },
            UiScaleError::Io(e) => CommandError::UiScaleIo {
                detail: e.to_string(),
            },
        }
    }
}

impl From<CaptureError> for CommandError {
    fn from(e: CaptureError) -> Self {
        match e {
            CaptureError::EmptySelection => CommandError::EmptySelection,
            CaptureError::SourceUnavailable(reason) => {
                CommandError::CaptureSourceUnavailable { reason }
            }
            CaptureError::SourceChanged => CommandError::CaptureSourceChanged,
            CaptureError::Sealed => CommandError::CaptureSealed,
            CaptureError::Pixels(detail) => CommandError::CapturePixels { detail },
            CaptureError::History(e) => e.into(),
        }
    }
}

impl From<HistoryError> for CommandError {
    fn from(e: HistoryError) -> Self {
        match e {
            HistoryError::Unknown => CommandError::CaptureUnknown,
            HistoryError::Collect(reason) => CommandError::CollectFailed { reason },
            HistoryError::Io(e) => CommandError::CaptureIo {
                detail: e.to_string(),
            },
            HistoryError::Image(e) => CommandError::CaptureSave {
                detail: e.to_string(),
            },
        }
    }
}

impl From<PinError> for CommandError {
    fn from(e: PinError) -> Self {
        match e {
            PinError::CropOutsideImage => CommandError::CropOutsideImage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_reach_the_interface_as_a_code_with_parameters() {
        let json = |e: CommandError| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(library::Error::CursorExpired.into()),
            serde_json::json!({ "code": "cursorExpired" })
        );
        assert_eq!(
            json(library::Error::AmbiguousTag("猫".into()).into()),
            serde_json::json!({ "code": "ambiguousTag", "name": "猫" })
        );
        assert_eq!(
            json(DeviceLibraryError::Library(library::Error::UnknownImage).into()),
            serde_json::json!({ "code": "unknownImage" })
        );
        assert_eq!(
            json(CatalogError::Library(library::Error::LensChanged).into()),
            serde_json::json!({ "code": "lensChanged" })
        );
        assert_eq!(
            json(CommandError::LibraryUnavailable {
                root: "E:\\库".into(),
                reason: "拒绝访问".into()
            }),
            serde_json::json!({ "code": "libraryUnavailable", "root": "E:\\库", "reason": "拒绝访问" })
        );
        assert_eq!(
            json(CommandError::message("没有代码")),
            serde_json::json!({ "code": "message", "message": "没有代码" })
        );
    }
}
