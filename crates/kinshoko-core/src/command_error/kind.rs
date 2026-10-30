//! 错误代码与参数（[`ErrorKind`]）。

use serde::Serialize;
use ts_rs::TS;

use crate::ShortcutAction;
use crate::reference_groups::{MemberUnavailable, UnavailableReason};
use crate::shortcuts::HotkeyFailure;

/// 命令失败的原因。`code` 决定文案，其余字段是文案里的参数。前端看到的类型名是 `CommandError`。
///
/// `detail` 是系统或底层库给出的原文（例如磁盘错误），按原样附在文案后面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
        cause: Box<ErrorKind>,
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
        cause: Box<ErrorKind>,
    },
    PackageImageUnsupported,
    MergeTargetGone,
    NamespaceGroup,
    NotInTrash,
    DeletePreviewStale,
    ReferenceGroupsUnchecked {
        cause: Box<ErrorKind>,
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
        cause: Box<ErrorKind>,
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
        cause: Box<ErrorKind>,
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
        cause: Box<ErrorKind>,
    },
    GroupMembersUnavailable {
        members: Vec<MemberUnavailable>,
    },
    NotAPackage,
    PackageDamaged {
        cause: Box<ErrorKind>,
    },

    // 备份（`BackupError`）。
    BackupTargetUnavailable {
        path: String,
    },
    UnknownSnapshot,
    SnapshotIncomplete {
        cause: Box<ErrorKind>,
    },
    BackupIo {
        detail: String,
    },
    BackupUnfinished,
    ManifestUnreadable {
        detail: String,
    },
    ManifestDamaged {
        detail: String,
    },
    NotABackup,
    BackupFromNewerVersion {
        version: u32,
    },
    SnapshotDatabaseKey,
    SnapshotLibraryMismatch {
        name: String,
    },
    SnapshotDefinitionsConflict {
        cause: Box<ErrorKind>,
    },
    SnapshotGroupUnreadable {
        name: String,
        detail: String,
    },
    SnapshotGroupMismatch {
        name: String,
    },
    SnapshotCapturesMismatch {
        name: String,
    },
    RestoreRoundTripMismatch,
    RestoreRollbackIncomplete {
        cause: Box<ErrorKind>,
        rollback: Box<ErrorKind>,
    },
    RestoreJournalDamaged {
        detail: String,
    },
    RestoreJournalMismatch,
    RestoreJournalLocation,
    RestoreStageNotOwned,
    RestoreResultLocation,
    RestoreLibraryMismatch,
    RestoreGroupMismatch,

    // 设置、快捷键与界面缩放。
    SettingsIo {
        detail: String,
    },
    SettingsBackupIncompatible,
    SettingsBackupNoLocation,
    SettingsPackageIncompatible,
    SettingsPackageSharedShortcut,
    SettingsBackupUnreadable {
        detail: String,
    },
    SettingsBackupInvalid {
        detail: String,
    },
    SettingsBackupExtension,
    SettingsBackupChanged,
    SettingsRestoreUnfinished,
    SettingsRestorePending {
        cause: Box<ErrorKind>,
    },
    SettingsRollbackIncomplete {
        cause: Box<ErrorKind>,
        rollback: Box<ErrorKind>,
        journal_kept: bool,
    },
    ShortcutUsedBy {
        action: ShortcutAction,
    },
    ShortcutUnavailable {
        reason: HotkeyFailure,
    },
    ShortcutTwoMainKeys,
    ShortcutNoMainKey,
    ShortcutHindersTyping,
    TagThresholdsInvalid,
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
        cause: Box<ErrorKind>,
    },
    CaptureNotAccepted,
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
    UpdateCheckFailed,
    UpdateManual,
    UpdateNoPublicKey,
    UpdateNoEndpoint,
    UpdateUnknownStage,
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

    // 标签定义不合要求的地方。
    DuplicateTagMapping,
    ConflictingTagDefinitions,
    TagNamespaceMismatch,
    SnapshotNamespaceMismatch,
    IdentityNamespaceConflict,
    InvalidTagIdentity,
    InvalidDefaultNames,
    InvalidTagAlias,
    InvalidExternalMapping,
    ClipboardImageEmpty,
    VocabularyNoNameColumn,
    SettingsTagReferences,

    // 参考组文件与参考组包不合要求的地方。
    GroupNameMissing,
    GroupMemberDuplicate {
        member: String,
    },
    GroupMemberScale {
        member: String,
    },
    GroupMemberRotation {
        member: String,
    },
    GroupMemberCaptureFile {
        member: String,
    },
    GroupMemberPin {
        member: String,
        cause: Box<ErrorKind>,
    },
    GroupIdentityExists,
    MemberCaptureFileInvalid,
    MemberCaptureMissing,
    GroupFileMismatch,
    NotAGroup,
    WrongFormatVersion,
    CaptureFileInvalid {
        file: String,
    },
    GroupCaptureUnreadable {
        file: String,
        detail: String,
    },
    GroupUnreadable {
        name: String,
        cause: Box<ErrorKind>,
    },
    PackageOriginalMismatch {
        path: String,
    },
    PackageNoDefinitions,
    PackageNoLocalMappings,
    PackageDefinitionNamespace,
    PackageConflictingDefinitions,
    PackageCaptureDuplicate {
        file: String,
    },
    PackageMemberNoImage {
        member: String,
    },
    PackageCaptureMissing {
        file: String,
    },
    PackageCaptureMismatch {
        file: String,
    },
    PackageImageMissing {
        file: String,
    },
    PackageImageMismatch {
        file: String,
    },
    /// 包导入做完 `done` 项后，第 `number` 项失败。
    PackageImportStopped {
        done: usize,
        total: usize,
        number: usize,
        cause: Box<ErrorKind>,
    },

    // 导入一项没有成功的原因。
    ImportWriteFailed {
        cause: Box<ErrorKind>,
    },
    ImportTargetUnavailable {
        cause: Box<ErrorKind>,
    },
    ImportItemCrashed,
    ImportCancelled,
    ImportUndecodable {
        detail: String,
    },
    StagedFileMismatch,
    OriginalContentMismatch,
    OriginalChangedDuringImport,
    PackageShaMismatch,
    DeletionMemoryUnreadable {
        detail: String,
    },
    EagleMetadataInvalid {
        detail: String,
    },
    EagleRelocationUnconfirmed,
    EagleFoldersInvalid,
    EagleItemPathInvalid,
    EagleItemFieldInvalid {
        field: String,
    },
    EagleItemIdMismatch,
    EagleItemSizeOrTags,
    EagleItemUnknownFolder {
        folder: String,
    },
    EagleItemSizeMismatch,

    // 自动标签：模型下载、导入与打标子进程。
    TaggingNoGpu,
    TaggingGpuUnreliable,
    TaggingVramShort {
        gpu: String,
        need: String,
    },
    TaggingRamShort {
        need: String,
    },
    TaggingNoModel,
    /// 几档模型各自用不了的原因。
    TaggingUnsuitable {
        reasons: Vec<ErrorKind>,
    },
    TaggingQueueUnreadable {
        cause: Box<ErrorKind>,
    },
    TaggingOriginalUnreadable {
        cause: Box<ErrorKind>,
    },
    TaggingStartFailed {
        cause: Box<ErrorKind>,
    },
    TaggingWriteFailed {
        cause: Box<ErrorKind>,
    },
    TaggingBadImage {
        cause: Box<ErrorKind>,
    },
    TaggerCrashed {
        cause: Box<ErrorKind>,
    },
    TaggingDeviceLost {
        cause: Box<ErrorKind>,
    },
    /// 打标子进程（推理库）报告的原文。
    TaggerReported {
        detail: String,
    },
    TaggerSpawnFailed {
        detail: String,
    },
    TaggerPipeFailed {
        detail: String,
    },
    TaggerUnresponsive {
        #[ts(type = "number")]
        seconds: u64,
    },
    TaggerExited {
        status: String,
    },
    TaggerUnexpectedReply {
        reply: String,
    },
    ModelDirFailed {
        detail: String,
    },
    ModelUnreadable {
        detail: String,
    },
    ModelChecksumFailed {
        model: String,
    },
    ModelTagsChecksumFailed {
        model: String,
    },
    ModelIncomplete {
        model: String,
    },
    ModelImportIncomplete {
        model: String,
    },
    ModelChunkFailed {
        model: String,
        detail: String,
    },
    ModelChunkChecksumFailed {
        model: String,
        sha: String,
    },
    ModelInstallFailed {
        detail: String,
    },
    ModelExtractFailed {
        detail: String,
    },
    ModelPackageUnopenable {
        detail: String,
    },
    ModelPackageNotZip {
        detail: String,
    },
    ModelPackageUnreadable {
        detail: String,
    },
    ModelPackageSeveralModels,
    ModelPackageNoModel,
    ModelPackageNoTags {
        file: String,
    },
    ModelPackageTagsInvalid {
        file: String,
    },
    ModelPackageUnsupported {
        file: String,
    },
    ModelPackageDamaged {
        file: String,
    },
    ModelPackageTagsMismatch {
        file: String,
        model: String,
    },
    DownloadRefused {
        status: u16,
    },
    /// `kind` 是网络库给出的错误种类，`message` 是它的原文。
    DownloadFailed {
        kind: String,
        message: Option<String>,
    },
    DownloadStopped,
    DownloadInterrupted {
        detail: String,
    },
    DownloadIncomplete {
        #[ts(type = "number")]
        done: u64,
        #[ts(type = "number")]
        total: u64,
    },

    /// 还原度门槛实验（开发用）不认识的取图方式。
    UnknownFidelitySample {
        what: String,
    },
}
