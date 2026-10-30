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
    DeviceLibraryError, SettingsError, ShortcutAction, ShortcutError, UiScaleError,
    WriterWaitError, library,
};

/// 命令失败的原因。`code` 决定文案，其余字段是文案里的参数。前端看到的类型名是 `CommandError`。
///
/// `detail` 是系统或底层库给出的原文（例如磁盘错误），按原样附在文案后面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[ts(export, rename = "CommandError")]
pub enum ErrorKind {
    /// 还没有错误代码的错误：`message` 按原样显示。
    Message {
        message: String,
    },

    // 资料库（`library::Error`）。
    InvalidLibraryName,
    TagDefinitionsNotSaved {
        reason: String,
    },
    NotEmpty {
        path: String,
    },
    NotALibrary {
        path: String,
    },
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
    AmbiguousTag {
        name: String,
    },
    DuplicateTagName {
        name: String,
    },
    ExternalTaken {
        name: String,
    },
    SameTag,
    UnknownEagleSource,
    EagleLocationTaken,
    LensChanged,
    OutdatedLibrary,
    PackageImage {
        reason: String,
    },
    MergeTargetGone,
    NamespaceGroup,
    NotInTrash,
    DeletePreviewStale,
    ReferenceGroupsUnchecked {
        reason: String,
    },
    Io {
        detail: String,
    },
    Database {
        detail: String,
    },
    Migration {
        detail: String,
    },
    ImageDecode {
        detail: String,
    },
    Undecodable {
        detail: String,
    },
    OriginalMissing {
        path: String,
    },
    ClipboardImage {
        reason: String,
    },

    // 本设备的资料库登记（`DeviceLibraryError`、`WriterWaitError`）。
    Registry {
        detail: String,
    },
    UnknownLibrary,
    StaleLibrary,
    IdentityChanged {
        root: String,
    },
    LibraryUnavailable {
        root: String,
        reason: String,
    },
    /// 这些资料库的导入一直没有收尾，整理没有执行。
    OrganizeTimedOut {
        libraries: Vec<String>,
    },

    // 统一标签目录（`CatalogError`）。
    CatalogIo {
        detail: String,
    },
    CatalogStorage {
        detail: String,
    },
    CatalogData {
        detail: String,
    },
    CatalogInvalidDefinition {
        reason: String,
    },
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
    GroupIo {
        detail: String,
    },
    UnknownGroup,
    InvalidGroupName,
    GroupNoMembers,
    GroupUnsupportedVersion {
        version: u32,
    },
    GroupInvalid {
        reason: String,
    },
    GroupMembersUnavailable {
        members: Vec<String>,
    },
    NotAPackage,
    PackageDamaged {
        reason: String,
    },

    // 备份（`BackupError`）。
    BackupTargetUnavailable {
        path: String,
    },
    UnknownSnapshot,
    SnapshotIncomplete {
        reason: String,
    },
    BackupIo {
        detail: String,
    },

    // 设置、快捷键与界面缩放。
    SettingsIo {
        detail: String,
    },
    ShortcutUsedBy {
        action: ShortcutAction,
    },
    ShortcutUnavailable {
        reason: String,
    },
    UiScaleUnsupported {
        percent: u16,
    },
    UiScaleIo {
        detail: String,
    },

    // 截图与钉图（`CaptureError`、`HistoryError`、`PinError`）。
    EmptySelection,
    CaptureSourceUnavailable {
        reason: UnavailableReason,
    },
    CaptureSourceChanged,
    CaptureSealed,
    CapturePixels {
        detail: String,
    },
    CaptureUnknown,
    CollectFailed {
        reason: String,
    },
    CaptureIo {
        detail: String,
    },
    CaptureSave {
        detail: String,
    },
    CropOutsideImage,
}

/// 命令层返回给界面的错误：序列化时只有错误代码与参数（[`ErrorKind`]），
/// `Display` 是原来的中文说明，用于日志和拼进别的说明里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError {
    pub kind: ErrorKind,
    text: String,
}

impl CommandError {
    /// 还没有错误代码的错误，按原样显示 `message`。
    pub fn message(message: impl fmt::Display) -> Self {
        let text = message.to_string();
        CommandError {
            kind: ErrorKind::Message {
                message: text.clone(),
            },
            text,
        }
    }

    /// 带代码的错误；`text` 是日志里的中文说明。
    pub fn new(kind: ErrorKind, text: impl Into<String>) -> Self {
        CommandError {
            kind,
            text: text.into(),
        }
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl std::error::Error for CommandError {}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.kind.serialize(serializer)
    }
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        CommandError::message(message)
    }
}

impl From<&str> for CommandError {
    fn from(message: &str) -> Self {
        CommandError::message(message)
    }
}

/// 系统与底层库的错误还没有错误代码，按原样显示。
macro_rules! from_foreign_error {
    ($($error:ty),* $(,)?) => {$(
        impl From<$error> for CommandError {
            fn from(e: $error) -> Self {
                CommandError::message(e)
            }
        }
    )*};
}

from_foreign_error!(std::io::Error, serde_json::Error, image::ImageError);

/// 领域错误连同它的中文说明一起转过来。
macro_rules! from_domain_error {
    ($($error:ty),* $(,)?) => {$(
        impl From<$error> for CommandError {
            fn from(e: $error) -> Self {
                let text = e.to_string();
                CommandError { kind: e.into(), text }
            }
        }
    )*};
}

from_domain_error!(
    library::Error,
    DeviceLibraryError,
    CatalogError,
    GroupError,
    BackupError,
    SettingsError,
    ShortcutError,
    UiScaleError,
    CaptureError,
    HistoryError,
    PinError,
);

impl<E: Into<ErrorKind> + fmt::Display> From<WriterWaitError<E>> for CommandError {
    fn from(e: WriterWaitError<E>) -> Self {
        let text = e.to_string();
        CommandError {
            kind: e.into(),
            text,
        }
    }
}

/// 钉图、截图要用的参考图此刻取不到。
impl From<UnavailableReason> for CommandError {
    fn from(reason: UnavailableReason) -> Self {
        let text = reason.to_string();
        CommandError {
            kind: ErrorKind::CaptureSourceUnavailable { reason },
            text,
        }
    }
}

impl From<CommandError> for ErrorKind {
    fn from(e: CommandError) -> Self {
        e.kind
    }
}

fn path(p: &Path) -> String {
    p.display().to_string()
}

impl From<library::Error> for ErrorKind {
    fn from(e: library::Error) -> Self {
        use library::Error as E;
        match e {
            E::InvalidName => ErrorKind::InvalidLibraryName,
            E::TagDefinitions(reason) => ErrorKind::TagDefinitionsNotSaved { reason },
            E::NotEmpty(p) => ErrorKind::NotEmpty { path: path(&p) },
            E::NotALibrary(p) => ErrorKind::NotALibrary { path: path(&p) },
            E::UnknownImage => ErrorKind::UnknownImage,
            E::SourceChanged => ErrorKind::SourceChanged,
            E::UnknownFolder => ErrorKind::UnknownFolder,
            E::FolderCycle => ErrorKind::FolderCycle,
            E::FolderReceivingImport => ErrorKind::FolderReceivingImport,
            E::InvalidCursor => ErrorKind::InvalidCursor,
            E::CursorExpired => ErrorKind::CursorExpired,
            E::InvalidDisplaySize => ErrorKind::InvalidDisplaySize,
            E::UnknownTag => ErrorKind::UnknownTag,
            E::UnknownTagGroup => ErrorKind::UnknownTagGroup,
            E::InvalidTagName => ErrorKind::InvalidTagName,
            E::AmbiguousTag(name) => ErrorKind::AmbiguousTag { name },
            E::DuplicateTagName(name) => ErrorKind::DuplicateTagName { name },
            E::ExternalTaken(name) => ErrorKind::ExternalTaken { name },
            E::NamespaceGroup => ErrorKind::NamespaceGroup,
            E::SameTag => ErrorKind::SameTag,
            E::UnknownEagleSource => ErrorKind::UnknownEagleSource,
            E::EagleLocationTaken => ErrorKind::EagleLocationTaken,
            E::LensChanged => ErrorKind::LensChanged,
            E::OutdatedLibrary => ErrorKind::OutdatedLibrary,
            E::PackageImage(reason) => ErrorKind::PackageImage { reason },
            E::MergeTargetGone => ErrorKind::MergeTargetGone,
            E::NotInTrash => ErrorKind::NotInTrash,
            E::DeletePreviewStale => ErrorKind::DeletePreviewStale,
            E::ReferenceGroups(reason) => ErrorKind::ReferenceGroupsUnchecked { reason },
            E::Io(e) => ErrorKind::Io {
                detail: e.to_string(),
            },
            E::Db(e) => ErrorKind::Database {
                detail: e.to_string(),
            },
            E::Migration(e) => ErrorKind::Migration {
                detail: e.to_string(),
            },
            E::Image(e) => ErrorKind::ImageDecode {
                detail: e.to_string(),
            },
            E::Undecodable(detail) => ErrorKind::Undecodable { detail },
            E::OriginalMissing(p) => ErrorKind::OriginalMissing { path: path(&p) },
            E::ClipboardImage(reason) => ErrorKind::ClipboardImage { reason },
        }
    }
}

impl From<DeviceLibraryError> for ErrorKind {
    fn from(e: DeviceLibraryError) -> Self {
        match e {
            DeviceLibraryError::Registry(e) => ErrorKind::Registry {
                detail: e.to_string(),
            },
            DeviceLibraryError::Library(e) => e.into(),
            DeviceLibraryError::UnknownLibrary => ErrorKind::UnknownLibrary,
            DeviceLibraryError::StaleLibrary => ErrorKind::StaleLibrary,
            DeviceLibraryError::IdentityChanged { root } => {
                ErrorKind::IdentityChanged { root: path(&root) }
            }
            DeviceLibraryError::Unavailable { root, reason } => ErrorKind::LibraryUnavailable {
                root: path(&root),
                reason,
            },
        }
    }
}

impl<E: Into<ErrorKind>> From<WriterWaitError<E>> for ErrorKind {
    fn from(e: WriterWaitError<E>) -> Self {
        match e {
            WriterWaitError::Request(e) => e.into(),
            WriterWaitError::TimedOut(notice) => ErrorKind::OrganizeTimedOut {
                libraries: notice.finishing,
            },
        }
    }
}

impl From<CatalogError> for ErrorKind {
    fn from(e: CatalogError) -> Self {
        match e {
            CatalogError::Io(e) => ErrorKind::CatalogIo {
                detail: e.to_string(),
            },
            CatalogError::Storage(e) => ErrorKind::CatalogStorage {
                detail: e.to_string(),
            },
            CatalogError::Data(e) => ErrorKind::CatalogData {
                detail: e.to_string(),
            },
            CatalogError::Library(e) => e.into(),
            CatalogError::UnknownTag => ErrorKind::CatalogUnknownTag,
            CatalogError::InvalidDefinition(reason) => {
                ErrorKind::CatalogInvalidDefinition { reason }
            }
            CatalogError::UnknownGroup => ErrorKind::CatalogUnknownGroup,
            CatalogError::InvalidGroupMembers => ErrorKind::CatalogInvalidGroupMembers,
            CatalogError::UnknownMapping => ErrorKind::CatalogUnknownMapping,
            CatalogError::NamespaceMismatch => ErrorKind::CatalogNamespaceMismatch,
            CatalogError::UnsupportedFormat => ErrorKind::CatalogUnsupportedFormat,
            CatalogError::InvalidName => ErrorKind::CatalogInvalidName,
            CatalogError::StaleNameMigration => ErrorKind::CatalogStaleNameMigration,
            CatalogError::StaleApproxConflict => ErrorKind::CatalogStaleApproxConflict,
            CatalogError::IncompleteNameMigration => ErrorKind::CatalogIncompleteNameMigration,
        }
    }
}

impl From<GroupError> for ErrorKind {
    fn from(e: GroupError) -> Self {
        match e {
            GroupError::Io(detail) => ErrorKind::GroupIo { detail },
            GroupError::UnknownGroup => ErrorKind::UnknownGroup,
            GroupError::InvalidName => ErrorKind::InvalidGroupName,
            GroupError::NoMembers => ErrorKind::GroupNoMembers,
            GroupError::UnsupportedVersion(version) => {
                ErrorKind::GroupUnsupportedVersion { version }
            }
            GroupError::Invalid(reason) => ErrorKind::GroupInvalid { reason },
            GroupError::MembersUnavailable(members) => {
                ErrorKind::GroupMembersUnavailable { members }
            }
            GroupError::NotAPackage => ErrorKind::NotAPackage,
            GroupError::PackageDamaged(reason) => ErrorKind::PackageDamaged { reason },
            GroupError::Library(message) => ErrorKind::Message { message },
        }
    }
}

impl From<BackupError> for ErrorKind {
    fn from(e: BackupError) -> Self {
        match e {
            BackupError::TargetUnavailable(p) => {
                ErrorKind::BackupTargetUnavailable { path: path(&p) }
            }
            BackupError::UnknownSnapshot => ErrorKind::UnknownSnapshot,
            BackupError::Incomplete(reason) => ErrorKind::SnapshotIncomplete { reason },
            BackupError::Io(e) => ErrorKind::BackupIo {
                detail: e.to_string(),
            },
            BackupError::Library(e) => e.into(),
            BackupError::Group(e) => e.into(),
        }
    }
}

impl From<SettingsError> for ErrorKind {
    fn from(e: SettingsError) -> Self {
        match e {
            SettingsError::Io(e) => ErrorKind::SettingsIo {
                detail: e.to_string(),
            },
            SettingsError::Invalid(why) => ErrorKind::Message {
                message: why.to_owned(),
            },
        }
    }
}

impl From<ShortcutError> for ErrorKind {
    fn from(e: ShortcutError) -> Self {
        match e {
            ShortcutError::Invalid(why) => ErrorKind::Message {
                message: why.to_owned(),
            },
            ShortcutError::UsedBy(action) => ErrorKind::ShortcutUsedBy { action },
            ShortcutError::Unavailable(reason) => ErrorKind::ShortcutUnavailable { reason },
            ShortcutError::Settings(e) => e.into(),
        }
    }
}

impl From<UiScaleError> for ErrorKind {
    fn from(e: UiScaleError) -> Self {
        match e {
            UiScaleError::Unsupported(percent) => ErrorKind::UiScaleUnsupported { percent },
            UiScaleError::Io(e) => ErrorKind::UiScaleIo {
                detail: e.to_string(),
            },
        }
    }
}

impl From<CaptureError> for ErrorKind {
    fn from(e: CaptureError) -> Self {
        match e {
            CaptureError::EmptySelection => ErrorKind::EmptySelection,
            CaptureError::SourceUnavailable(reason) => {
                ErrorKind::CaptureSourceUnavailable { reason }
            }
            CaptureError::SourceChanged => ErrorKind::CaptureSourceChanged,
            CaptureError::Sealed => ErrorKind::CaptureSealed,
            CaptureError::Pixels(detail) => ErrorKind::CapturePixels { detail },
            CaptureError::History(e) => e.into(),
        }
    }
}

impl From<HistoryError> for ErrorKind {
    fn from(e: HistoryError) -> Self {
        match e {
            HistoryError::Unknown => ErrorKind::CaptureUnknown,
            HistoryError::Collect(reason) => ErrorKind::CollectFailed { reason },
            HistoryError::Io(e) => ErrorKind::CaptureIo {
                detail: e.to_string(),
            },
            HistoryError::Image(e) => ErrorKind::CaptureSave {
                detail: e.to_string(),
            },
        }
    }
}

impl From<PinError> for ErrorKind {
    fn from(e: PinError) -> Self {
        match e {
            PinError::CropOutsideImage => ErrorKind::CropOutsideImage,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_reach_the_interface_as_a_code_with_parameters() {
        let json = |e: CommandError| serde_json::to_value(e).unwrap();
        let text = |e: CommandError| e.to_string();
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
            json(
                DeviceLibraryError::Unavailable {
                    root: "E:\\库".into(),
                    reason: "拒绝访问".into()
                }
                .into()
            ),
            serde_json::json!({ "code": "libraryUnavailable", "root": "E:\\库", "reason": "拒绝访问" })
        );
        assert_eq!(
            text(library::Error::UnknownImage.into()),
            "资料库中没有这张参考图"
        );
        assert_eq!(
            json(CommandError::message("没有代码")),
            serde_json::json!({ "code": "message", "message": "没有代码" })
        );
    }
}
