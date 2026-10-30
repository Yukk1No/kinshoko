import type { SaveDestination } from "./bindings/SaveDestination";
import type { ImportOptions } from "./bindings/ImportOptions";
import type { LibraryTarget } from "./bindings/LibraryTarget";
import type { LibraryDeletePreview } from "./bindings/LibraryDeletePreview";
import type { LibraryDeleteToken } from "./bindings/LibraryDeleteToken";
import type { LibraryBatchFailure } from "./bindings/LibraryBatchFailure";
// 前端调用 Tauri 命令的唯一入口。参数与返回值的类型来自 ts-rs 生成的 ./bindings，
// 不在这里手写；Rust 侧改了类型，重新生成后这里会在类型检查时报错。
import { invoke } from "./ipc/invoke";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AppInfo } from "./bindings/AppInfo";
import type { EagleLibraryCandidate } from "./bindings/EagleLibraryCandidate";
import type { EagleTagMapping } from "./bindings/EagleTagMapping";
import type { MappedExternal } from "./bindings/MappedExternal";
import type { EagleLocationChoice } from "./bindings/EagleLocationChoice";
import type { ImageDetail } from "./bindings/ImageDetail";
import type { ImageEdit } from "./bindings/ImageEdit";
import type { PermanentDeletePreview } from "./bindings/PermanentDeletePreview";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { LibraryRegistration } from "./bindings/LibraryRegistration";
import type { RecoveryReport } from "./bindings/RecoveryReport";
import type { Sidebar } from "./bindings/Sidebar";
import { lib } from "./ipc/plugins";
import { isErrorCode } from "./ipc/commandError";
export * from "./ipc/tagsAndSearch";
export * from "./ipc/shell";
export * from "./ipc/desktop";
export * from "./ipc/groups";
export * from "./ipc/workspace";
export * from "./ipc/commandError";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}


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
 * 浏览失败是不是因为分页游标过期（`cursorExpired`）：游标所依据的结果集已经变了，接着翻会遗漏或重复（#77）。
 * 不是错误，从第一页重新浏览即可。
 */
export function isCursorExpired(error: unknown): boolean {
  return isErrorCode(error, "cursorExpired");
}

/**
 * 命令失败是不是因为这张图已查不到（`unknownImage`：图不存在、在别的资料库，或安全模式下被封印，#60）。
 * 应关闭查看它的界面、回到图片墙。
 */
export function isUnknownImage(error: unknown): boolean {
  return isErrorCode(error, "unknownImage");
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

/**
 * 跨图库的永久删除预览（#112）：后端按图库分组，逐组切换可写句柄预览；核对不了的图库只带原因。
 */
export function previewPermanentDeleteBatch(targets: LibraryTarget[]): Promise<LibraryDeletePreview[]> {
  return invoke<LibraryDeletePreview[]>(lib("preview_permanent_delete_batch"), { targets });
}

/** 按各图库的预览令牌逐组永久删除；返回没删完的图库与原因，全部完成时为空。 */
export function permanentDeleteBatch(groups: LibraryDeleteToken[]): Promise<LibraryBatchFailure[]> {
  return invoke<LibraryBatchFailure[]>(lib("permanent_delete_batch"), { groups });
}

/** 按预览的令牌永久删除回收站里的图；预览之后有变化时被拒绝（{@link isDeletePreviewStale}）。 */
export function permanentDelete(libraryId: string, ids: string[], token: string): Promise<void> {
  return invoke<void>(lib("permanent_delete"), { libraryId, ids, token });
}

/** 永久删除被拒绝（`deletePreviewStale`）：预览之后回收站、参考组或安全模式变了，要重新预览。 */
export function isDeletePreviewStale(error: unknown): boolean {
  return isErrorCode(error, "deletePreviewStale");
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

/** 删除文件夹及其子文件夹（#114）：图片不删，没有其他文件夹的回到未归类。 */
export function deleteFolder(libraryId: string, folderId: string): Promise<void> {
  return invoke<void>(lib("delete_folder"), { libraryId, folderId });
}

/** 清空回收站的预览（#114）：这个图库回收站里看得见的全部图与受影响的参考组；确认后交给 {@link permanentDelete}。 */
export function previewEmptyTrash(libraryId: string): Promise<PermanentDeletePreview> {
  return invoke<PermanentDeletePreview>(lib("preview_empty_trash"), { libraryId });
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

/** 标签管理：改某个来源名称的语言（纠正按文字判断的误判，#217）；`und` 表示未注明语言。 */
export function setSourceNameLang(libraryId: string, tagId: string, name: string, lang: string): Promise<void> {
  return invoke<void>(lib("set_source_name_lang"), { libraryId, tagId, name, lang });
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
