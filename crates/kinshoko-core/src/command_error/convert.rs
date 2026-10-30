//! 领域错误换成错误代码。

use std::path::Path;

use super::ErrorKind;
use crate::backup::BackupError;
use crate::desktop::{CaptureError, HistoryError, PinError};
use crate::reference_groups::GroupError;
use crate::tag_catalog::CatalogError;
use crate::{
    DeviceLibraryError, SettingsError, ShortcutError, UiScaleError, WriterWaitError, library,
};

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
            // 只在订阅检查线程里出现，不经命令交给界面；错误代码随订阅界面的文案再加（#368）。
            e @ E::SubscriptionImage(_) => ErrorKind::Message {
                message: e.to_string(),
            },
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
