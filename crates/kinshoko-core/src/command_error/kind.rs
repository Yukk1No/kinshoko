//! 错误代码与参数（[`ErrorKind`]）。

use serde::Serialize;
use ts_rs::TS;

use crate::ShortcutAction;
use crate::reference_groups::UnavailableReason;

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
    /// 资料库此刻打不开；`cause` 是打不开的原因。
    LibraryUnavailable {
        root: String,
        cause: Box<ErrorKind>,
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

    // 导入一项时的失败（`ImportOutcome::ReadFailed`）。
    ImportDestinationUnavailable {
        cause: Box<ErrorKind>,
    },
    ImportWriteFailed {
        cause: Box<ErrorKind>,
    },
    ImportItemFailed,
    ImportCancelled,
    EagleSizeMismatch,
    ImportUndecodable {
        detail: String,
    },
    PackageHashMismatch,
    DeleteMemoryUnreadable {
        detail: String,
    },

    // 应用壳（Tauri 层）的错误。
    NoLibraryOpen,
    NoLibrary,
    GroupsNotReady,
    DestinationMismatch,
    /// 安全模式在操作期间变了，要重新做的分别是：检查标签对应、读取标签名称、打开名称迁移向导、框选。
    SafeModeChangedMapping,
    SafeModeChangedNames,
    SafeModeChangedMigration,
    SafeModeChangedCapture,
    CaptureSourceClosed,
    NoCaptureInProgress,
    CaptureSourceMoving,
    CaptureSessionExpired,
    CaptureInvalidReport,
    CaptureWindowRebuilt,
    CaptureUnconfirmed,
    CaptureGoneClosePin,
    CapturesChanged,
    /// 存进参考组时第 `index` 张截图没能收藏，之前的 `completed` 张已收藏。
    CollectPartial {
        index: u32,
        completed: u32,
        cause: Box<ErrorKind>,
    },
    NoBackupTarget,
    BackupTargetMissing {
        path: String,
    },
    BackupRunning,
    BackupOrRestoreRunning,
    ClipboardEmpty,
    ClipboardUnreadable,
    CopyEmpty,
    CopyPrepare {
        detail: String,
    },
    CopyNoWindow,
    ClipboardOpen {
        detail: String,
    },
    ClipboardFormat,
    ClipboardWrite {
        detail: String,
    },
    ClipboardPartial {
        detail: String,
    },
    CopyTooWide,
    CopyTooTall,
    CopyTooLarge,
    CopyNoMemory,
    CopySealed,
    ExplorerFailed {
        detail: String,
    },
    PinClosed,
    PinLocked,
    NoMonitor,
    AutostartFailed {
        detail: String,
    },
    UnknownInterfaceLanguage {
        lang: String,
    },
    DiagnosticsSaveFailed {
        detail: String,
    },
    Webview2PageFailed,
    ClearLogFailed {
        detail: String,
    },
    NoUpdate,
    /// 改动已保存，资料库里的标签定义还没更新；`cause` 是没能更新的原因。
    MappingSavedDefinitionsPending {
        cause: Box<ErrorKind>,
    },
    TagsSavedDefinitionsPending {
        cause: Box<ErrorKind>,
    },
    SourceTagsSavedDefinitionsPending {
        cause: Box<ErrorKind>,
    },
    CatalogDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    PackageDefinitionsPending {
        cause: Box<ErrorKind>,
    },
}
