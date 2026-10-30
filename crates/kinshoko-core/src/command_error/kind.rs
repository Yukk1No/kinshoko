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
    /// 系统或底层库的错误（窗口、线程、剪贴板等）：`detail` 是它们给出的原文，按原样显示。
    System {
        detail: String,
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

    // 以下是 Tauri 命令层自己的错误。
    /// 本设备还没有登记任何资料库。
    NoLibrary,
    LibraryNotOpen,
    ReferenceGroupsNotReady,
    /// 导入或保存任务认领的资料库与这次的保存目标不一致。
    SaveTargetMismatch,
    UnknownInterfaceLanguage {
        lang: String,
    },
    AutostartFailed {
        cause: Box<ErrorKind>,
    },
    ClearRunLogFailed {
        detail: String,
    },
    RunLogNotOpen,
    DiagnosticsSaveFailed {
        cause: Box<ErrorKind>,
    },
    WebView2PageFailed,
    /// 不是 Windows 时打不开下载页，只能请画师自己去。
    VisitWebView2Page,
    OpenExplorerFailed {
        detail: String,
    },
    /// 不是 Windows 时打不开文件管理器，只能请画师自己去。
    OpenInFileManager {
        path: String,
    },
    NoMonitor,
    UpdateNotPending,
    UpdateSignatureInvalid,
    UpdateInstallFailed,

    // 安全模式在操作途中变了。
    TagMappingSafeModeChanged,
    TagNamesSafeModeChanged,
    NameMigrationSafeModeChanged,

    // 内容已保存，但资料库里的标签定义没有跟着更新。
    DefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    MappingDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    TagEditDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    SourceTagDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    PackageDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    ProcessedDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },
    SavedDefinitionsNotSaved {
        cause: Box<ErrorKind>,
    },

    // 恢复程序设置后没有完全生效的部分。
    AutostartNotSynced {
        cause: Box<ErrorKind>,
    },
    SafeModeScopeIncomplete {
        cause: Box<ErrorKind>,
    },
    LibraryNamesNotRefreshed {
        cause: Box<ErrorKind>,
    },
    LibraryListNotRefreshed {
        cause: Box<ErrorKind>,
    },

    // 备份与恢复的操作。
    NoBackupTarget,
    BackupTargetMissing {
        path: String,
    },
    BackupRunning,
    BackupOrRestoreRunning,

    // 框选截图。
    NoCaptureInProgress,
    CaptureSessionExpired,
    CaptureSourceClosed,
    CaptureSourceMoving,
    CaptureSafeModeChanged,
    CaptureSourceBoundsInvalid,
    CaptureMainWindowRebuilt,
    CaptureSourcesUnconfirmed,

    // 钉图、参考组与剪贴板。
    PinClosed,
    PinLocked,
    PinVeiledNoCopy,
    /// 截图钉图对应的截图已不在截图历史中。
    PinCaptureGone,
    /// 存进参考组时，截图钉图对应的截图已不在截图历史中。
    CaptureLeftHistory,
    CaptureSavePlanChanged,
    /// 第 `number` 张截图没能收藏；前面 `completed` 张已收藏。
    CaptureCollectIncomplete {
        number: usize,
        completed: usize,
        cause: Box<ErrorKind>,
    },
    ClipboardNoImage,
    ClipboardImageUnrecognized,
    CopiedImageEmpty,
    CopiedImageTooWide,
    CopiedImageTooTall,
    CopiedImageTooLarge,
    CopiedImageNoMemory,
    CopyPrepareFailed {
        detail: String,
    },
    ClipboardNoWindow,
    ClipboardFormatUnavailable,
    ClipboardOpenFailed {
        detail: String,
    },
    ClipboardWriteFailed {
        detail: String,
    },
    ClipboardPartlyWritten {
        detail: String,
    },

    /// 还原度门槛实验（开发用）不认识的取图方式。
    UnknownFidelitySample {
        what: String,
    },
}
