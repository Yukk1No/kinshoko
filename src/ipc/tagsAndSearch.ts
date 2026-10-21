import type { OrganizeWaiting } from "../bindings/OrganizeWaiting";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ApproxRelation } from "../bindings/ApproxRelation";
import type { PersonalApproxEntry } from "../bindings/PersonalApproxEntry";
import type { RatingCandidate } from "../bindings/RatingCandidate";
import type { Candidate } from "../bindings/Candidate";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { ImageRating } from "../bindings/ImageRating";
import type { ImageTags } from "../bindings/ImageTags";
import type { LibraryEvent } from "../bindings/LibraryEvent";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { TagAlias } from "../bindings/TagAlias";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { Vocabulary } from "../bindings/Vocabulary";
import { lib, testPick } from "./plugins";

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
 * 搜索框打字时的分级候选（#161），与资料库无关。安全模式开着时（`safeMode` 或应用设置）
 * 不含成人内容的分级。
 */
export function ratingCandidates(text: string, safeMode: boolean): Promise<RatingCandidate[]> {
  return invoke<RatingCandidate[]>(lib("rating_candidates"), { text, safeMode });
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

/**
 * 整理另一个图库时后端把唯一的可写句柄切了过去（ADR-0008，#112）。界面没有“当前图库”，
 * 只有跟着可写库走的部分（自动标签）需要知道。
 */
export function onWritableLibrary(handler: (library: LibraryInfo) => void): Promise<UnlistenFn> {
  return listen<LibraryInfo>("writable-library", (e) => handler(e.payload));
}

/** 整理在等某个图库的导入收尾（#112）：完成后自动执行，界面只给轻提示。 */
export function onOrganizeWaiting(handler: (waiting: OrganizeWaiting) => void): Promise<UnlistenFn> {
  return listen<OrganizeWaiting>("organize-waiting", (e) => handler(e.payload));
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
