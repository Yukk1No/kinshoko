// 前端调用 Tauri 命令的唯一入口。参数与返回值的类型来自 ts-rs 生成的 ./bindings，
// 不在这里手写；Rust 侧改了类型，重新生成后这里会在类型检查时报错。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AppInfo } from "./bindings/AppInfo";
import type { ApproxRelation } from "./bindings/ApproxRelation";
import type { PersonalApproxEntry } from "./bindings/PersonalApproxEntry";
import type { Candidate } from "./bindings/Candidate";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { BrowsePage } from "./bindings/BrowsePage";
import type { BrowseQuery } from "./bindings/BrowseQuery";
import type { ImageDetail } from "./bindings/ImageDetail";
import type { ImageEdit } from "./bindings/ImageEdit";
import type { ImageRating } from "./bindings/ImageRating";
import type { ImageTags } from "./bindings/ImageTags";
import type { LibraryEvent } from "./bindings/LibraryEvent";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { RecoveryReport } from "./bindings/RecoveryReport";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { Sidebar } from "./bindings/Sidebar";
import type { ShortcutAction } from "./bindings/ShortcutAction";
import type { TagEdit } from "./bindings/TagEdit";
import type { TagGroupView } from "./bindings/TagGroupView";
import type { TaggingStatus } from "./bindings/TaggingStatus";
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

export function browse(query: BrowseQuery): Promise<BrowsePage> {
  return invoke<BrowsePage>(lib("browse"), { query });
}

/** 单张参考图的详情。 */
export function imageDetail(imageId: string): Promise<ImageDetail> {
  return invoke<ImageDetail>(lib("image"), { imageId });
}

/** 一次批量整理若干张图，返回重新计算后的详情。 */
export function editImages(ids: string[], edits: ImageEdit[]): Promise<ImageDetail[]> {
  return invoke<ImageDetail[]>(lib("edit"), { ids, edits });
}

/** 侧栏：全部、回收站与文件夹树，计数只算可见的图。 */
export function sidebar(): Promise<Sidebar> {
  return invoke<Sidebar>(lib("sidebar"));
}

/** 新建文件夹，放在 parent 下（null 为顶层）的最后，返回文件夹 id。 */
export function createFolder(name: string, parent: string | null): Promise<string> {
  return invoke<string>(lib("create_folder"), { name, parent });
}

export function renameFolder(folderId: string, name: string): Promise<void> {
  return invoke<void>(lib("rename_folder"), { folderId, name });
}

/** 把文件夹移到 parent 下（null 为顶层）的第 position 位，超出时放在最后。 */
export function moveFolder(folderId: string, parent: string | null, position: number): Promise<void> {
  return invoke<void>(lib("move_folder"), { folderId, parent, position });
}

/** 开始导入，立即返回任务 id；进度与结果经 onLibraryEvent 推送。 */
export function startImport(paths: string[]): Promise<string> {
  return invoke<string>(lib("start_import"), { source: { paths } });
}

export function cancelImport(taskId: string): Promise<void> {
  return invoke<void>(lib("cancel_import"), { taskId });
}

/** 当前资料库这次打开时的对账结果：撤回的中断导入项与不认识的孤立文件。 */
export function libraryRecovery(): Promise<RecoveryReport> {
  return invoke<RecoveryReport>(lib("recovery"));
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
export function imageTags(imageId: string, lang: string): Promise<ImageTags> {
  return invoke<ImageTags>(lib("image_tags"), { imageId, lang });
}

/** 对若干参考图批量添加、否决或清除标签决定。 */
export function editTags(imageIds: string[], edits: TagEdit[]): Promise<void> {
  return invoke<void>(lib("edit_tags"), { imageIds, edits });
}

/** 标签词表快照，按 revision 缓存；词表变化时收到 vocabularyChanged 事件。 */
export function vocabulary(): Promise<Vocabulary> {
  return invoke<Vocabulary>(lib("vocabulary"));
}

/** 侧栏的标签分组及计数，名称按界面语言 lang。 */
export function tagGroups(lang: string): Promise<TagGroupView[]> {
  return invoke<TagGroupView[]>(lib("tag_groups"), { lang });
}

/** 搜索框打字时的候选：按命名空间与别名列出，最多 limit 个。 */
export function searchCandidates(text: string, lang: string, limit: number): Promise<Candidate[]> {
  return invoke<Candidate[]>(lib("search_candidates"), { text, lang, limit });
}

/** 把搜索框里的条件解析成可见的条件树，交给 browse 执行。 */
export function resolveSearch(input: SearchInput, lang: string): Promise<ConditionTree> {
  return invoke<ConditionTree>(lib("resolve_search"), { input, lang });
}

/** 在个人近似对应表中记下两个标签相近（“＋”）或不相近（“以后都不展开”）。 */
export function setTagApprox(a: string, b: string, relation: ApproxRelation): Promise<void> {
  return invoke<void>(lib("set_tag_approx"), { a, b, relation });
}

/** 删除个人近似对应表中的一对，之后按内置近似对应表。 */
export function removeTagApprox(a: string, b: string): Promise<void> {
  return invoke<void>(lib("remove_tag_approx"), { a, b });
}

/** 个人近似对应表的条目，最近记下的在前，名称按界面语言 lang。 */
export function personalApprox(lang: string): Promise<PersonalApproxEntry[]> {
  return invoke<PersonalApproxEntry[]>(lib("personal_approx"), { lang });
}

export function onLibraryEvent(handler: (event: LibraryEvent) => void): Promise<UnlistenFn> {
  return listen<LibraryEvent>("library-event", (e) => handler(e.payload));
}

/** 卡片上的缩略图地址（自定义协议 thumb）转成 <img> 可用的 URL。 */
export function thumbnailUrl(address: string): string {
  return convertFileSrc("", "thumb") + address;
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
export function imageRating(imageId: string): Promise<ImageRating> {
  return invoke<ImageRating>(lib("image_rating"), { imageId });
}

/** 自动标签的当前状态；还没打开资料库时 reject。 */
export function taggingStatus(): Promise<TaggingStatus> {
  return invoke<TaggingStatus>("tagging_status");
}

/** 画师确认后下载打标模型（可续传）。 */
export function taggingDownload(): Promise<void> {
  return invoke<void>("tagging_download");
}

/** 暂停打标：结束打标子进程，归还显存。 */
export function taggingPause(): Promise<void> {
  return invoke<void>("tagging_pause");
}

export function taggingResume(): Promise<void> {
  return invoke<void>("tagging_resume");
}

export function onTaggingStatus(handler: (status: TaggingStatus) => void): Promise<UnlistenFn> {
  return listen<TaggingStatus>("tagging-status", (e) => handler(e.payload));
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
