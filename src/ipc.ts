import type { SaveDestination } from "./bindings/SaveDestination";
import type { ImportTaskSnapshot } from "./bindings/ImportTaskSnapshot";
import type { WorkspaceDirectories } from "./bindings/WorkspaceDirectories";
import type { LegacyNameMigrationPreview } from "./bindings/LegacyNameMigrationPreview";
import type { LegacyNameMigrationWorkspace } from "./bindings/LegacyNameMigrationWorkspace";
import type { LegacyNameDecision } from "./bindings/LegacyNameDecision";
import type { WorkspaceQuery } from "./bindings/WorkspaceQuery";
import type { WorkspacePage } from "./bindings/WorkspacePage";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import type { CatalogNameEdit } from "./bindings/CatalogNameEdit";
import type { ImportOptions } from "./bindings/ImportOptions";
// 前端调用 Tauri 命令的唯一入口。参数与返回值的类型来自 ts-rs 生成的 ./bindings，
// 不在这里手写；Rust 侧改了类型，重新生成后这里会在类型检查时报错。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CatalogCorrection } from "./bindings/CatalogCorrection";
import type { CatalogImageTags } from "./bindings/CatalogImageTags";
import type { TagCatalogWorkspace } from "./bindings/TagCatalogWorkspace";
import type { AppInfo } from "./bindings/AppInfo";
import type { ApproxRelation } from "./bindings/ApproxRelation";
import type { PersonalApproxEntry } from "./bindings/PersonalApproxEntry";
import type { Candidate } from "./bindings/Candidate";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { BackupPreview } from "./bindings/BackupPreview";
import type { BackupStatus } from "./bindings/BackupStatus";
import type { RestoreReport } from "./bindings/RestoreReport";
import type { ScopeSelection } from "./bindings/ScopeSelection";
import type { SnapshotSummary } from "./bindings/SnapshotSummary";
import type { BrowsePage } from "./bindings/BrowsePage";
import type { BrowseQuery } from "./bindings/BrowseQuery";
import type { EagleLibraryCandidate } from "./bindings/EagleLibraryCandidate";
import type { EagleTagMapping } from "./bindings/EagleTagMapping";
import type { MappedExternal } from "./bindings/MappedExternal";
import type { EagleLocationChoice } from "./bindings/EagleLocationChoice";
import type { CaptureAction } from "./bindings/CaptureAction";
import type { CaptureEntry } from "./bindings/CaptureEntry";
import type { CollectedCapture } from "./bindings/CollectedCapture";
import type { FrozenScreen } from "./bindings/FrozenScreen";
import type { ImageDetail } from "./bindings/ImageDetail";
import type { ImageEdit } from "./bindings/ImageEdit";
import type { PermanentDeletePreview } from "./bindings/PermanentDeletePreview";
import type { ImageRating } from "./bindings/ImageRating";
import type { GatePlan } from "./bindings/GatePlan";
import type { GroupSummary } from "./bindings/GroupSummary";
import type { ReferenceGroup } from "./bindings/ReferenceGroup";
import type { ReferenceGroupView } from "./bindings/ReferenceGroupView";
import type { ImageTags } from "./bindings/ImageTags";
import type { PinFrame } from "./bindings/PinFrame";
import type { Region } from "./bindings/Region";
import type { ScreenRect } from "./bindings/ScreenRect";
import type { LibraryEvent } from "./bindings/LibraryEvent";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { LibraryRegistration } from "./bindings/LibraryRegistration";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { RecoveryReport } from "./bindings/RecoveryReport";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { Sidebar } from "./bindings/Sidebar";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { TagAlias } from "./bindings/TagAlias";
import type { TagEdit } from "./bindings/TagEdit";
import type { TagNamespace } from "./bindings/TagNamespace";
import type { TagGroupView } from "./bindings/TagGroupView";
import type { LibraryTaggingStatus } from "./bindings/LibraryTaggingStatus";
import type { Turn } from "./bindings/Turn";
import type { UpdateProgress } from "./bindings/UpdateProgress";
import type { UpdateStatus } from "./bindings/UpdateStatus";
import type { Vocabulary } from "./bindings/Vocabulary";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

const lib =(command: string) => `plugin:library|${command}`;

/** 当前资料库；启动后第一次调用时打开本设备上次打开的资料库。 */
export function currentLibrary(): Promise<LibraryInfo | null> {
  return invoke<LibraryInfo | null>(lib("current_library"));
}

/** 在 parent 下新建名为 name 的资料库，登记到本设备并打开。 */
export function createLibrary(parent: string, name: string): Promise<LibraryInfo> {
  return invoke<LibraryInfo>(lib("create_library"), { parent, name });
}

export function registeredLibraries(): Promise<LibraryRegistration[]> {
  return invoke<LibraryRegistration[]>(lib("registered_libraries"));
}

export function registerLibrary(root: string): Promise<LibraryInfo> {
  return invoke<LibraryInfo>(lib("register_library"), { root });
}

export function switchLibrary(libraryId: string): Promise<LibraryInfo> {
  return invoke<LibraryInfo>(lib("switch_library"), { libraryId });
}

export function unregisterLibrary(libraryId: string): Promise<void> {
  return invoke<void>(lib("unregister_library"), { libraryId });
}

/**
 * 按查询浏览一页。`query.cursor` 所依据的结果集已经变了（换了视角、查询，或可见集合变化）时
 * 被拒绝（{@link isCursorExpired}），从第一页重读。
 */
export function browse(libraryId: string, query: BrowseQuery): Promise<BrowsePage> {
  return invoke<BrowsePage>(lib("browse"), { libraryId, query });
}

/** 资料库的 `CursorExpired`：分页游标所依据的结果集已经变了，接着翻会遗漏或重复（#77）。 */
const CURSOR_EXPIRED = "浏览结果已变化，请从头重新浏览";

/** 浏览失败是不是因为分页游标过期：不是错误，从第一页重新浏览即可。 */
export function isCursorExpired(error: unknown): boolean {
  return String(error) === CURSOR_EXPIRED;
}

/** 资料库的 `UnknownImage`：图不存在、在别的资料库，或安全模式下被封印（#60）。 */
const UNKNOWN_IMAGE = "资料库中没有这张参考图";

/** 命令失败是不是因为这张图已查不到（应关闭查看它的界面、回到图片墙）。 */
export function isUnknownImage(error: unknown): boolean {
  return String(error) === UNKNOWN_IMAGE;
}

/** 单张参考图的详情。 */
export function imageDetail(libraryId: string, imageId: string): Promise<ImageDetail> {
  return invoke<ImageDetail>(lib("image"), { libraryId, imageId });
}

/** 一次批量整理若干张图，返回重新计算后的详情。 */
export function editImages(libraryId: string, ids: string[], edits: ImageEdit[]): Promise<ImageDetail[]> {
  return invoke<ImageDetail[]>(lib("edit"), { libraryId, ids, edits });
}

/**
 * 永久删除的预览（#67）：回收站里这些图会影响哪些参考组，以及执行时要交回的令牌。
 * 参考组读不懂时被拒绝，不当作没用到。
 */
export function previewPermanentDelete(libraryId: string, ids: string[]): Promise<PermanentDeletePreview> {
  return invoke<PermanentDeletePreview>(lib("preview_permanent_delete"), { libraryId, ids });
}

/** 按预览的令牌永久删除回收站里的图；预览之后有变化时被拒绝（{@link isDeletePreviewStale}）。 */
export function permanentDelete(libraryId: string, ids: string[], token: string): Promise<void> {
  return invoke<void>(lib("permanent_delete"), { libraryId, ids, token });
}

const DELETE_PREVIEW_STALE = "回收站或参考组在确认前有变化，请重新查看将受影响的参考组";

/** 永久删除被拒绝：预览之后回收站、参考组或安全模式变了，要重新预览。 */
export function isDeletePreviewStale(error: unknown): boolean {
  return String(error) === DELETE_PREVIEW_STALE;
}

/** 侧栏：全部、回收站与文件夹树，计数只算可见的图。 */
export function sidebar(libraryId: string): Promise<Sidebar> {
  return invoke<Sidebar>(lib("sidebar"), { libraryId });
}

/** 新建文件夹，放在 parent 下（null 为顶层）的最后，返回文件夹 id。 */
export function createFolder(libraryId: string, name: string, parent: string | null): Promise<string> {
  return invoke<string>(lib("create_folder"), { libraryId, name, parent });
}

export function renameFolder(libraryId: string, folderId: string, name: string): Promise<void> {
  return invoke<void>(lib("rename_folder"), { libraryId, folderId, name });
}

/** 把文件夹移到 parent 下（null 为顶层）的第 position 位，超出时放在最后。 */
export function moveFolder(libraryId: string, folderId: string, parent: string | null, position: number): Promise<void> {
  return invoke<void>(lib("move_folder"), { libraryId, folderId, parent, position });
}

/** 开始导入，立即返回任务 id；进度与结果经 onLibraryEvent 推送。 */
export function startImport(libraryId: string, paths: string[], options?: ImportOptions, destination?: SaveDestination): Promise<string> {
  return invoke<string>(lib("start_import"), { libraryId, source: { paths }, ...(options ? { options } : {}), ...(destination ? { destination } : {}) });
}

/** 与实际导入相同的只读 Eagle 来源识别；用于手选、父文件夹、拖入及重试的统一选择。 */
export function importContainsEagle(paths: string[]): Promise<boolean> {
  return invoke<boolean>(lib("import_contains_eagle"), { source: { paths } });
}

/** 本机 Eagle 资料库候选；按 images/ 条目数从多到少排列。 */
export function discoverEagleLibraries(): Promise<EagleLibraryCandidate[]> {
  return invoke<EagleLibraryCandidate[]>(lib("discover_eagle_libraries"));
}

/** 迁入向导“标签的外部对应”：自动匹配还没有外部对应的 Eagle 标签，返回对上与没对上的。 */
export function eagleTagMapping(libraryId: string, lang: string): Promise<EagleTagMapping> {
  return invoke<EagleTagMapping>(lib("eagle_tag_mapping"), { libraryId, lang });
}

/** 画师给一个标签补上外部对应，之后它参与内置近似对应表。 */
export function mapTagExternal(libraryId: string, tagId: string, external: string): Promise<MappedExternal> {
  return invoke<MappedExternal>(lib("map_tag_external"), { libraryId, tagId, external });
}

/** 补外部对应时的联想（外部词表属于本设备）。 */
export function externalSuggestions(text: string, limit: number): Promise<string[]> {
  return invoke<string[]>(lib("external_suggestions"), { text, limit });
}

/** 确认导入报告里疑似搬家的 Eagle 位置；确认后再导入这个位置。 */
export function confirmEagleLocation(libraryId: string, path: string, choice: EagleLocationChoice): Promise<void> {
  return invoke<void>(lib("confirm_eagle_location"), { libraryId, path, choice });
}

export function cancelImport(libraryId: string, taskId: string): Promise<void> {
  return invoke<void>(lib("cancel_import"), { libraryId, taskId });
}

/** 当前资料库这次打开时的对账结果：撤回的中断导入项与不认识的孤立文件。 */
export function libraryRecovery(libraryId: string): Promise<RecoveryReport> {
  return invoke<RecoveryReport>(lib("recovery"), { libraryId });
}

export type FileDrop = { kind: "enter"; paths: string[] } | { kind: "drop"; paths: string[] } | { kind: "leave" };

/** 文件或文件夹拖进主窗口：进入、松开（带路径）、离开。 */
export function onFileDrop(handler: (drop: FileDrop) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    switch (payload.type) {
      case "enter":
        handler({ kind: "enter", paths: payload.paths });
        break;
      case "drop":
        handler({ kind: "drop", paths: payload.paths });
        break;
      case "leave":
        handler({ kind: "leave" });
        break;
    }
  });
}

/** 一张参考图的有效标签及出处、被否决的标签，名称按界面语言 lang。 */
export function imageTags(libraryId: string, imageId: string, lang: string): Promise<ImageTags> {
  return invoke<ImageTags>(lib("image_tags"), { libraryId, imageId, lang });
}

/** 对若干参考图批量添加、否决或清除标签决定。 */
export function editTags(libraryId: string, imageIds: string[], edits: TagEdit[]): Promise<void> {
  return invoke<void>(lib("edit_tags"), { libraryId, imageIds, edits });
}

/** 标签词表快照，按 revision 缓存；词表变化时收到 vocabularyChanged 事件。 */
export function vocabulary(libraryId: string): Promise<Vocabulary> {
  return invoke<Vocabulary>(lib("vocabulary"), { libraryId });
}

/** 侧栏的标签分组及计数，名称按界面语言 lang。 */
export function tagGroups(libraryId: string, lang: string): Promise<TagGroupView[]> {
  return invoke<TagGroupView[]>(lib("tag_groups"), { libraryId, lang });
}

/** 给标签加一个别名（按语言 lang 区分，null 为不区分）；之后按这个叫法能查到、能添加它。 */
export function addTagAlias(libraryId: string, tagId: string, alias: TagAlias): Promise<void> {
  return invoke<void>(lib("add_tag_alias"), { libraryId, tagId, alias });
}

export function removeTagAlias(libraryId: string, tagId: string, alias: string): Promise<void> {
  return invoke<void>(lib("remove_tag_alias"), { libraryId, tagId, alias });
}

/** 建立标签分组，返回分组 id；给出 namespace 时分组是该命名空间的全部标签。 */
export function createTagGroup(libraryId: string, name: string, namespace: TagNamespace | null): Promise<string> {
  return invoke<string>(lib("create_tag_group"), { libraryId, name, namespace });
}

export function renameTagGroup(libraryId: string, groupId: string, name: string): Promise<void> {
  return invoke<void>(lib("rename_tag_group"), { libraryId, groupId, name });
}

/** 删除标签分组；标签本身与标签决定不受影响。 */
export function deleteTagGroup(libraryId: string, groupId: string): Promise<void> {
  return invoke<void>(lib("delete_tag_group"), { libraryId, groupId });
}

/** 把标签加进画师整理的分组，排在最后。 */
export function addToTagGroup(libraryId: string, groupId: string, tagIds: string[]): Promise<void> {
  return invoke<void>(lib("add_to_tag_group"), { libraryId, groupId, tagIds });
}

/** 把标签移出画师整理的分组；安全模式下看不见的成员不受影响。 */
export function removeFromTagGroup(libraryId: string, groupId: string, tagIds: string[]): Promise<void> {
  return invoke<void>(lib("remove_from_tag_group"), { libraryId, groupId, tagIds });
}

/** 资料库的 `LensChanged`：请求带的安全模式与资料库的不同（刚切换过），结果作废（#76）。 */
const LENS_CHANGED = "安全模式刚切换过，请重新查找";

/** 查找命令失败是不是因为安全模式刚切换过：不是错误，切换确认后会按新视角重新查找。 */
export function isLensChanged(error: unknown): boolean {
  return String(error) === LENS_CHANGED;
}

/**
 * 搜索框打字时的候选：按命名空间与别名列出，最多 limit 个。`safeMode` 是界面当前的视角；
 * 资料库的安全模式不同时被拒绝（{@link isLensChanged}），候选不会落到另一视角上。
 */
export function searchCandidates(
  libraryId: string,
  text: string,
  lang: string,
  limit: number,
  safeMode: boolean,
): Promise<Candidate[]> {
  return invoke<Candidate[]>(lib("search_candidates"), { libraryId, text, lang, limit, safeMode });
}

/** 把搜索框里的条件解析成可见的条件树，交给 browse 执行。`safeMode` 同 {@link searchCandidates}。 */
export function resolveSearch(
  libraryId: string,
  input: SearchInput,
  lang: string,
  safeMode: boolean,
): Promise<ConditionTree> {
  return invoke<ConditionTree>(lib("resolve_search"), { libraryId, input, lang, safeMode });
}

/** 在个人近似对应表中记下两个标签相近（“＋”）或不相近（“以后都不展开”）。 */
export function setTagApprox(
  libraryId: string,
  a: string,
  b: string,
  relation: ApproxRelation,
): Promise<void> {
  return invoke<void>(lib("set_tag_approx"), { libraryId, a, b, relation });
}

/** 删除个人近似对应表中的一对，之后按内置近似对应表。 */
export function removeTagApprox(libraryId: string, a: string, b: string): Promise<void> {
  return invoke<void>(lib("remove_tag_approx"), { libraryId, a, b });
}

/** 个人近似对应表的条目，最近记下的在前，名称按界面语言 lang。 */
export function personalApprox(libraryId: string, lang: string): Promise<PersonalApproxEntry[]> {
  return invoke<PersonalApproxEntry[]>(lib("personal_approx"), { libraryId, lang });
}

/** Global safe-mode setting changes invalidate asynchronous browser inspection results. */
export function onSafeModeSetting(handler: (on: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("safe-mode-setting", (event) => handler(event.payload));
}
export function onLibraryEvent(handler: (event: LibraryEvent) => void): Promise<UnlistenFn> {
  return listen<LibraryEvent>("library-event", (e) => handler(e.payload));
}

/** 卡片上的缩略图地址（自定义协议 thumb）转成 <img> 可用的 URL。 */
export function thumbnailUrl(address: string): string {
  return convertFileSrc("", "thumb") + address;
}

/** 1:1 与放大时显示的图（看图界面只用这条路）：静态 SDR 原图，或动图、HDR、Chromium 不能
 * 精确表示的 ICC 与 CMYK 的原尺寸 sdr 派生图（ADR-0005）。 */
export function displayUrl(libraryId: string, imageId: string): string {
  return convertFileSrc("", "thumb") + `${libraryId}/${imageId}/full`;
}

/** 查看器缩小显示（适应窗口等）的地址：targetPx 是转正后的设备像素宽度。不小于原图宽度时
 * 与 displayUrl 相同；更小时是精确尺寸的 sdr 派生图，不交给 Chromium 缩小（#47）。 */
export function displayScaledUrl(libraryId: string, imageId: string, targetPx: number): string {
  return convertFileSrc("", "thumb") + `${libraryId}/${imageId}/fit-${targetPx}`;
}

// 原生文件对话框无法由 WebDriver 操作。冒烟测试先把要“选中”的路径放进
// window.__KINSHOKO_TEST_PICKS__，有值时按顺序取用，不弹对话框。
declare global {
  interface Window {
    __KINSHOKO_TEST_PICKS__?: (string | string[] | null)[];
  }
}

function testPick<T>(): { value: T } | null {
  const queue = window.__KINSHOKO_TEST_PICKS__;
  return queue && queue.length ? { value: queue.shift() as T } : null;
}

export function pickFolder(): Promise<string | null> {
  const t = testPick<string | null>();
  return t ? Promise.resolve(t.value) : invoke<string | null>(lib("pick_folder"));
}

export function pickFiles(): Promise<string[]> {
  const t = testPick<string[]>();
  return t ? Promise.resolve(t.value ?? []) : invoke<string[]>(lib("pick_files"));
}

/** 一张参考图的内容分级（自动与有效）。 */
export function imageRating(libraryId: string, imageId: string): Promise<ImageRating> {
  return invoke<ImageRating>(lib("image_rating"), { libraryId, imageId });
}

/** 安全模式是否开启（全局设置，新装默认开启）。 */
export function safeMode(): Promise<boolean> {
  return invoke<boolean>(lib("safe_mode"));
}

/** 开关安全模式；当前资料库随后推送 safeModeChanged。 */
export function setSafeMode(on: boolean): Promise<boolean> {
  return invoke<boolean>(lib("set_safe_mode"), { on });
}

/** 自动标签的当前状态；还没打开资料库时 reject。 */
export function taggingStatus(libraryId: string): Promise<LibraryTaggingStatus> {
  return invoke<LibraryTaggingStatus>("tagging_status", { libraryId });
}

/** 画师确认后下载打标模型（可续传）。 */
export function taggingDownload(libraryId: string): Promise<void> {
  return invoke<void>("tagging_download", { libraryId });
}

/** 暂停打标：结束打标子进程，归还显存。 */
export function taggingPause(libraryId: string): Promise<void> {
  return invoke<void>("tagging_pause", { libraryId });
}

export function taggingResume(libraryId: string): Promise<void> {
  return invoke<void>("tagging_resume", { libraryId });
}

/** 设置中的打标模型列表与画师选的模型。 */
export function taggingModels(): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_models");
}

/** 换用打标模型（`null` 为自动），保存在本设备。 */
export function taggingSetModel(key: string | null): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_set_model", { key });
}

/** 选择要导入的模型包（zip）；取消时为 null。 */
export function pickModelPackage(): Promise<string | null> {
  const t = testPick<string | null>();
  return t ? Promise.resolve(t.value) : invoke<string | null>("tagging_pick_package");
}

/** 从文件导入模型包并校验；校验不过时 reject 中文原因。 */
export function importModelPackage(path: string): Promise<ModelChoice> {
  return invoke<ModelChoice>("tagging_import_package", { path });
}

export function onTaggingStatus(handler: (status: LibraryTaggingStatus) => void): Promise<UnlistenFn> {
  return listen<LibraryTaggingStatus>("tagging-status", (e) => handler(e.payload));
}

/** 应用壳设置：开机自启与全局快捷键。 */
export function shellSettings(): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("shell_settings");
}

/** 开关开机自启。失败时 reject 一条给画师看的中文原因。 */
export function setAutostart(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_autostart", { on });
}

/** 开关查找条件里相近标签的来源标记（内置／个人）。 */
export function setShowApproxSource(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_show_approx_source", { on });
}

/** 更换全局快捷键，立即生效；`null` 表示清除。失败时 reject 中文原因，原来的键不变。 */
export function rebindShortcut(
  action: ShortcutAction,
  accelerator: string | null,
): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("rebind_shortcut", { action, accelerator });
}

/** 诊断开关“强制 sRGB”：保存后重启 Kinshoko 生效。 */
export function setForceSrgb(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_force_srgb", { on });
}

/** 开关使用日志（只写本机），立即生效。 */
export function setUsageLog(on: boolean): Promise<ShellSettingsView> {
  return invoke<ShellSettingsView>("set_usage_log", { on });
}

// ---------- 诊断与更新（#70） ----------

/** 诊断日志全文：硬件、系统、WebView2 与显示器色彩状态，不含文件名、路径与图片。 */
export function diagnosticsReport(): Promise<string> {
  return invoke<string>("diagnostics_report");
}

/** 把诊断日志存成文件；画师取消时为 false。 */
export function exportDiagnostics(): Promise<boolean> {
  return invoke<boolean>("export_diagnostics");
}

/** 把使用日志导出成文件；画师取消时为 false。 */
export function exportUsageLog(): Promise<boolean> {
  return invoke<boolean>("export_usage_log");
}

/** 删掉已记录的使用日志。 */
export function clearUsageLog(): Promise<void> {
  return invoke<void>("clear_usage_log");
}

/** 上次检查更新的结果。 */
export function updateStatus(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("update_status");
}

// ---------- 本地备份与恢复（#69） ----------

/** 备份计划（目标、范围、上次结果）与正在进行的备份。 */
export function backupStatus(): Promise<BackupStatus> {
  return invoke<BackupStatus>("backup_status");
}

/** 选择备份目标目录；`null` 为清除。 */
export function setBackupTarget(target: string | null): Promise<BackupStatus> {
  return invoke<BackupStatus>("set_backup_target", { target });
}

export function setBackupSelection(selection: ScopeSelection): Promise<BackupStatus> {
  return invoke<BackupStatus>("set_backup_selection", { selection });
}

/** 执行前的范围、未覆盖内容与容量。 */
export function backupPreview(selection: ScopeSelection): Promise<BackupPreview> {
  return invoke<BackupPreview>("backup_preview", { selection });
}

/** 马上备份一次；进度与结果经 `onBackupStatus` 推送。 */
export function startBackup(): Promise<void> {
  return invoke<void>("start_backup");
}

export function backupSnapshots(): Promise<SnapshotSummary[]> {
  return invoke<SnapshotSummary[]>("backup_snapshots");
}

/** 从快照恢复出独立的资料库（放在 `into` 下）与参考组，返回自动运行的往返检查结果。 */
export function restoreBackup(snapshotId: string, into: string): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_backup", { snapshotId, into });
}

export function onBackupStatus(handler: (status: BackupStatus) => void): Promise<UnlistenFn> {
  return listen<BackupStatus>("backup-status", (e) => handler(e.payload));
}

/** 向 GitHub Releases 检查新版本。 */
export function checkUpdate(): Promise<UpdateStatus> {
  return invoke<UpdateStatus>("check_update");
}

/** 下载并安装新版本；成功时 Kinshoko 退出、装好后重新启动。 */
export function installUpdate(): Promise<void> {
  return invoke<void>("install_update");
}

export function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update-progress", (e) => handler(e.payload));
}

// ---------- 截图与钉图（#62） ----------

const desk = (command: string) => `plugin:desktop|${command}`;

/** 开始框选截图（与全局快捷键相同）。 */
export function startCapture(): Promise<void> {
  return invoke<void>(desk("start_capture"));
}

/** 框选窗口：要显示的冻结屏幕；没有进行中的截图时为 null。 */
export function frozenScreen(): Promise<FrozenScreen | null> {
  return invoke<FrozenScreen | null>(desk("frozen_screen"));
}

/** 框选窗口：冻结屏幕已画好，可以显示窗口了。 */
export function captureReady(): Promise<void> {
  return invoke<void>(desk("capture_ready"));
}

/** 框选完成；region 是相对显示器的物理像素。 */
export function finishCapture(region: Region, action: CaptureAction): Promise<void> {
  return invoke<void>(desk("finish_capture"), { region, action });
}

export function cancelCapture(): Promise<void> {
  return invoke<void>(desk("cancel_capture"));
}

/** 把剪贴板里的图片钉住；剪贴板没有图片时 reject 中文原因。 */
export function pinClipboard(): Promise<void> {
  return invoke<void>(desk("pin_clipboard"));
}

/** 从截图历史钉住一张截图。 */
export function pinCapture(id: string): Promise<void> {
  return invoke<void>(desk("pin_capture"), { id });
}

/** 钉图窗口当前的一帧：要画的钉图、原生窗口与内容的位置；钉图已关闭时为 null。 */
export function pinFrame(pin: string): Promise<PinFrame | null> {
  return invoke<PinFrame | null>(desk("pin_frame"), { pin });
}

/** 发给本钉图窗口的帧（缩放、贴边滑动、翻转旋转、透明度、锁定都经这里，#64）。 */
export function onPinFrame(handler: (frame: PinFrame) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<PinFrame>("pin-frame", (e) => handler(e.payload));
}

/** 动画结束：让应用壳把原生窗口改成静止时的矩形（只认最新一帧的 generation）。 */
export function settlePin(pin: string, generation: number): Promise<void> {
  return invoke<void>(desk("settle_pin"), { pin, generation });
}

/** 透明度 0.1～1。 */
export function setPinOpacity(pin: string, opacity: number): Promise<void> {
  return invoke<void>(desk("set_pin_opacity"), { pin, opacity });
}

/** 锁定后钉图不响应拖动与缩放。 */
export function setPinLocked(pin: string, locked: boolean): Promise<void> {
  return invoke<void>(desk("set_pin_locked"), { pin, locked });
}

/** 钉图窗口：第一帧已画好，可以显示了。 */
export function pinReady(pin: string): Promise<void> {
  return invoke<void>(desk("pin_ready"), { pin });
}

/**
 * 从查看器把参考图钉到桌面（#65）：整图（crop 为 null）或局部（原图像素）。
 * shown 是这块此刻在查看器里的位置（物理像素，相对窗口客户区），新钉图以它为中心略微错开。
 */
export function pinReference(
  libraryId: string,
  imageId: string,
  crop: Region | null,
  shown: ScreenRect,
): Promise<void> {
  return invoke<void>(desk("pin_reference"), { libraryId, imageId, crop, shown });
}

/** 画师确认显示这张被遮蔽的参考图（安全模式下，只这一张）。 */
export function revealPin(pin: string): Promise<void> {
  return invoke<void>(desk("reveal_pin"), { pin });
}

/**
 * 资料库钉图的图（经参考视角，只给已钉住的图）。size 为 "full"（1:1，原图或 sdr 派生图）或
 * 原图整张缩到的宽度（物理像素，精确尺寸的 sdr 派生图）。
 */
export function pinImageUrl(pin: string, size: "full" | number): string {
  return captureUrl(`pin/${pin}/${size === "full" ? "full" : `fit-${size}`}`);
}

/** 只关闭收到 Esc 的活动钉图窗口，沿用原生关闭后的保存与截图历史清理。 */
export function closePin(pin: string): Promise<void> {
  return invoke<void>(desk("close_pin"), { pin });
}

/** 在钉图上弹出右键菜单。 */
export function pinMenu(pin: string): Promise<void> {
  return invoke<void>(desk("pin_menu"), { pin });
}

/** 拖动钉图（笔、鼠标、触摸同一套）：移到屏幕物理像素 (x, y)，成为新的原位。锁定时 reject。 */
export function movePin(pin: string, x: number, y: number): Promise<void> {
  return invoke<void>(desk("move_pin"), { pin, x, y });
}

/** 缩放钉图；屏幕上的 (anchorX, anchorY)（物理像素）不动。新状态以 pin-frame 到达；锁定时 reject。 */
export function zoomPin(pin: string, scale: number, anchorX: number, anchorY: number): Promise<void> {
  return invoke<void>(desk("zoom_pin"), { pin, scale, anchorX, anchorY });
}

/** 翻转与旋转动作，来自 Rust `kinshoko_core::desktop::Turn` 的生成绑定。 */
export type PinTurn = Turn;

/** 翻转或旋转钉图（中心不动）。新状态以 pin-frame 到达。 */
export function turnPin(pin: string, turn: PinTurn): Promise<void> {
  return invoke<void>(desk("turn_pin"), { pin, turn });
}

/** 贴边隐藏全部钉图，或让它们回到原位（与全局快捷键相同）。 */
export function edgeHide(): Promise<void> {
  return invoke<void>(desk("edge_hide"));
}

export function captureHistory(): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("capture_history"));
}

/** 收藏：经资料库的普通导入入口存进当前资料库。 */
export function collectCapture(id: string, destination:SaveDestination): Promise<CollectedCapture> {
  return invoke<CollectedCapture>(desk("collect_capture"), { id, destination });
}

export function deleteCapture(id: string): Promise<void> {
  return invoke<void>(desk("delete_capture"), { id });
}

export function onCaptureHistory(handler: (entries: CaptureEntry[]) => void): Promise<UnlistenFn> {
  return listen<CaptureEntry[]>("capture-history", (e) => handler(e.payload));
}

// ---------- 参考组（#66） ----------

/** 本设备的参考组，最近保存的在前；读不懂的文件也列出（`problem`）。 */
export function referenceGroups(): Promise<GroupSummary[]> {
  return invoke<GroupSummary[]>(desk("reference_groups"));
}

/** 一个参考组及每个成员此刻能否显示（跨资料库核对）。 */
export function referenceGroup(groupId: string): Promise<ReferenceGroupView> {
  return invoke<ReferenceGroupView>(desk("reference_group"), { groupId });
}

/** 把桌面上的资料库钉图存成新的参考组（截图钉图不进组）。 */
export function saveReferenceGroup(name: string, captures: import("./bindings/CaptureChoice").CaptureChoice[] = []): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_reference_group"), { name, captures });
}

/** 把桌面上的资料库钉图存进已有的参考组：来自它的更新原成员，其他的加为新成员。 */
export function savePinsToGroup(groupId: string, captures: import("./bindings/CaptureChoice").CaptureChoice[] = []): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_pins_to_group"), { groupId, captures });
}

export function groupSaveCaptures(): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("group_save_captures"));
}

/** 报告查看器已显示的参考图范围；全局 F1 据此保留来源与原图像素裁切。 */
export function setCaptureReference(reference: import("./bindings/CaptureReference").CaptureReference | null): Promise<void> {
  return invoke<void>(desk("set_capture_reference"), { reference });
}

/** 打开参考组：成员按保存的局部与摆放钉到桌面；返回新钉出的数量。 */
export function openReferenceGroup(groupId: string): Promise<number> {
  return invoke<number>(desk("open_reference_group"), { groupId });
}

export function renameReferenceGroup(groupId: string, name: string): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("rename_reference_group"), { groupId, name });
}

export function deleteReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("delete_reference_group"), { groupId });
}

export function removeGroupMember(groupId: string, memberId: string): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("remove_group_member"), { groupId, memberId });
}

/**
 * 把参考组导出成参考组包（#68）：带上所用原图与标签、备注、来源、分级的快照。
 * 弹出保存对话框；取消时为 null，成功时为包的位置。
 */
export function exportReferenceGroupPackage(groupId: string): Promise<string | null> {
  const t = testPick<string | null>();
  if (t && t.value === null) return Promise.resolve(null);
  return invoke<string | null>(desk("export_reference_group_package"), { groupId, path: t?.value ?? null });
}

/**
 * 导入参考组包（#68）到资料库 `libraryId`，另存为新的参考组。弹出选择对话框；取消时为 null。
 */
export function importReferenceGroupPackage(libraryId: string, destination?:SaveDestination): Promise<ReferenceGroup | null> {
  const t = testPick<string | null>();
  if (t && t.value === null) return Promise.resolve(null);
  return invoke<ReferenceGroup | null>(desk("import_reference_group_package"), {
    libraryId, ...(destination?{destination}:{}),
    path: t?.value ?? null,
  });
}

/** 参考组有变化（保存、重命名、删除）：重新读取。 */
export function onReferenceGroupsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("reference-groups", () => handler());
}

/** 发给本钉图窗口的提示（例如“已收藏到…”）。只收发给这个窗口的，不收别的钉图的。 */
export function onPinNotice(handler: (text: string) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<string>("pin-notice", (e) => handler(e.payload));
}

/** 截图历史中的截图或冻结屏幕（自定义协议 capture）转成 <img> 可用的 URL。 */
export function captureUrl(address: string): string {
  return convertFileSrc("", "capture") + address;
}

// ---------- 还原度门槛实验（#45） ----------

/** 等样本资料库准备好后取得门槛实验计划。 */
export function gatePlan(): Promise<GatePlan> {
  return invoke<GatePlan>("gate_plan");
}

/** 样本的原文件、应用 1:1 显示的文件（display）或某档缩略图的原始字节。 */
export async function gateImage(
  imageId: string,
  what: "original" | "display" | { thumbnail: number },
): Promise<Uint8Array<ArrayBuffer>> {
  // 原始字节在自定义协议 IPC 下是 ArrayBuffer，退回 postMessage 时是数字数组。
  const raw = await invoke<ArrayBuffer | number[]>("gate_image", {
    imageId,
    what: typeof what === "string" ? what : "thumbnail",
    px: typeof what === "string" ? null : what.thumbnail,
  });
  return raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
}

/** 保存报告，返回 JSON 报告的路径。无人值守运行时保存后退出。 */
export function gateSave(report: unknown, markdown: string, passed: boolean): Promise<string> {
  return invoke<string>("gate_save", { report, markdown, passed });
}

/** Inspect registered content providers and durable application-level tag mappings. */
export function inspectTagCatalog(): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("inspect_tag_catalog"));
}

export function correctTagMapping(libraryId: string, localTagId: string, correction: CatalogCorrection): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("correct_tag_mapping"), { libraryId, localTagId, correction });
}

export function catalogImageTags(libraryId: string, imageId: string, lang: string): Promise<CatalogImageTags> {
  return invoke<CatalogImageTags>(lib("catalog_image_tags"), { libraryId, imageId, lang });
}

/** Application workspace queries. These never switch an active library or write destination. */
export function workspaceBrowse(query: WorkspaceQuery, safeMode: boolean): Promise<WorkspacePage> {
  return invoke<WorkspacePage>(lib("workspace_browse"), { query, safeMode });
}
export function workspaceStatus(safeMode: boolean): Promise<WorkspaceStatus> {
  return invoke<WorkspaceStatus>(lib("workspace_status"), { safeMode });
}
export function workspaceResolve(input: SearchInput, lang: string, safeMode: boolean): Promise<ConditionTree> {
  return invoke<ConditionTree>(lib("workspace_resolve"), { input, lang, safeMode });
}
export function workspaceCandidates(text: string, lang: string, limit: number, safeMode: boolean): Promise<Candidate[]> {
  return invoke<Candidate[]>(lib("workspace_candidates"), { text, lang, limit, safeMode });
}
export function workspaceImage(libraryId: string, imageId: string): Promise<ImageDetail> {
  return invoke<ImageDetail>(lib("workspace_image"), { libraryId, imageId });
}
export function workspaceSidebar(libraryId: string, safeMode: boolean): Promise<Sidebar> {
  return invoke<Sidebar>(lib("workspace_sidebar"), { libraryId, safeMode });
}
export function workspaceTagGroups(libraryId: string, lang: string, safeMode: boolean): Promise<TagGroupView[]> {
  return invoke<TagGroupView[]>(lib("workspace_tag_groups"), { libraryId, lang, safeMode });
}
export function workspaceLocalTags(libraryId: string, ids: string[], safeMode: boolean): Promise<string[]> {
  return invoke<string[]>(lib("workspace_local_tags"), { libraryId, ids, safeMode });
}
export function onWorkspaceChanged(handler: (status: WorkspaceStatus) => void): Promise<UnlistenFn> {
  return listen<WorkspaceStatus>("workspace-changed", (event) => handler(event.payload));
}

export function editTagName(catalogId: string, edit: CatalogNameEdit): Promise<TagCatalogWorkspace> {
  return invoke<TagCatalogWorkspace>(lib("edit_tag_name"), { catalogId, edit });
}


// Explicit aggregate-source actions keep browsing and the current library independent.
export function workspaceSourceInspection(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, lang: string): Promise<import("./bindings/WorkspaceSourceInspection").WorkspaceSourceInspection> {
  return invoke(lib("workspace_source_inspection"), { target, safeMode, lang });
}
export function workspaceEditSource(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, edits: ImageEdit[]): Promise<void> {
  return invoke(lib("workspace_edit_source"), { target, safeMode, edits });
}
export function workspaceEditSourceTags(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, edits: TagEdit[]): Promise<void> {
  return invoke(lib("workspace_edit_source_tags"), { target, safeMode, edits });
}
export function workspaceSourceCandidates(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, text: string, lang: string, safeMode: boolean): Promise<Candidate[]> {
  return invoke(lib("workspace_source_candidates"), { target, text, lang, safeMode });
}

export function workspaceSourceGroup(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, choice: { groupId: string; name?: never } | { name: string; groupId?: never }): Promise<ReferenceGroup> {
  return invoke(lib("workspace_source_group"), { target, safeMode, groupId: choice.groupId ?? null, name: choice.name ?? null });
}

export function workspacePreviewSourceDelete(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean): Promise<PermanentDeletePreview> {
  return invoke(lib("workspace_preview_source_delete"), { target, safeMode });
}
export function workspacePermanentSourceDelete(target: import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget, safeMode: boolean, token: string): Promise<void> {
  return invoke(lib("workspace_permanent_source_delete"), { target, safeMode, token });
}

export function workspaceDirectories(safeMode: boolean): Promise<WorkspaceDirectories> {
  return invoke<WorkspaceDirectories>(lib("workspace_directories"), { safeMode });
}

/** Unknown legacy names: read a safe-mode-filtered plan; confirm all choices atomically. */
export function planLegacyNames(): Promise<LegacyNameMigrationWorkspace> {
  return invoke<LegacyNameMigrationWorkspace>(lib("plan_legacy_names"));
}
export function confirmLegacyNames(revision: number, decisions: LegacyNameDecision[]): Promise<LegacyNameMigrationWorkspace> {
  return invoke<LegacyNameMigrationWorkspace>(lib("confirm_legacy_names"), { revision, decisions });
}

export function previewLegacyNames(revision: number, decisions: LegacyNameDecision[]): Promise<LegacyNameMigrationPreview> {
  return invoke<LegacyNameMigrationPreview>(lib("preview_legacy_names"), { revision, decisions });
}

export function importTasks(): Promise<ImportTaskSnapshot[]> { return invoke<ImportTaskSnapshot[]>(lib("import_tasks")); }
export function dismissImport(libraryId:string,taskId:string): Promise<void> { return invoke<void>(lib("dismiss_import"),{libraryId,taskId}); }

export function takeCollectionRequest(): Promise<string|null> { return invoke<string|null>(desk("take_collection_request")); }
export function onCollectionRequest(handler:()=>void): Promise<UnlistenFn> { return listen("capture-collection-request",handler); }
export function workspaceCopySource(target:import("./bindings/WorkspaceSourceTarget").WorkspaceSourceTarget,destination:SaveDestination,safeMode:boolean): Promise<string> { return invoke<string>(lib("workspace_copy_source"),{target,destination,safeMode}); }
