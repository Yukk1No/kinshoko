import type { SaveDestination } from "../bindings/SaveDestination";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { GatePlan } from "../bindings/GatePlan";
import type { PinGate } from "../bindings/PinGate";
import type { DeletedGroup } from "../bindings/DeletedGroup";
import type { DeskLists } from "../bindings/DeskLists";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroup } from "../bindings/ReferenceGroup";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { desk, testPick } from "./plugins";

/** 本设备的参考组，最近保存的在前；读不懂的文件也列出（`problem`）。 */
export function referenceGroups(): Promise<GroupSummary[]> {
  return invoke<GroupSummary[]>(desk("reference_groups"));
}

/** 一个参考组及每个成员此刻能否显示（跨资料库核对）。 */
export function referenceGroup(groupId: string): Promise<ReferenceGroupView> {
  return invoke<ReferenceGroupView>(desk("reference_group"), { groupId });
}

/** 把桌面钉图存成新的参考组；截图按逐张选择收藏后入组、只存在参考组里，或不加入。 */
export function saveReferenceGroup(
  name: string,
  captures: import("../bindings/CaptureChoice").CaptureChoice[] = [],
): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_reference_group"), { name, captures });
}

/** 把桌面上的资料库钉图存进已有的参考组：来自它的更新原成员，其他的加为新成员。 */
export function savePinsToGroup(
  groupId: string,
  captures: import("../bindings/CaptureChoice").CaptureChoice[] = [],
): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_pins_to_group"), { groupId, captures });
}

/** 桌面上要决定怎样入组的截图；存进已有的参考组 `groupId` 时，已是它自带截图的不列出。 */
export function groupSaveCaptures(groupId?: string): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("group_save_captures"), groupId ? { groupId } : {});
}

/**
 * 参考组改成桌面（#588、#591）：侧栏三段，常用（按画师设的先后）、最近（新建的在前）、
 * 更早（没设常用又一个月没用过的）。`onDesk` 为空时桌面空着。
 * 设置里界面上没有的开关 `deskReferenceGroups` 关着时报错 `deskGroupsOff`。
 */
export function deskReferenceGroups(): Promise<DeskLists> {
  return invoke<DeskLists>(desk("desk_reference_groups"));
}

/**
 * 空桌上钉下第一张、开了新参考组，而且有上一组时推送，载荷是新参考组与上一组的 id（`{ groupId, previousId }`）：
 * 提示里可以“加进「上一组」”（{@link foldIntoPrevious}）。
 */
export const DESK_GROUP_STARTED_EVENT = "desk-group-started";

/** 整桌换成参考组 `groupId`，原来那一桌原样留着。 */
export function switchReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("switch_reference_group"), { groupId });
}

/** 清空桌面（“新建”）：原来那一组原样留着，之后钉下的第一张开一个新参考组。 */
export function newReferenceDesk(): Promise<void> {
  return invoke<void>(desk("new_reference_desk"));
}

/** 钉回桌面上参考组里没钉着的成员，在它原来的位置。 */
export function repinGroupMember(memberId: string): Promise<void> {
  return invoke<void>(desk("repin_group_member"), { memberId });
}

/** 全部钉上：桌面上参考组里已关闭的成员都在原位置钉出。 */
export function repinAllGroupMembers(): Promise<void> {
  return invoke<void>(desk("repin_all_group_members"));
}

/** 侧栏里点了参考组的一张图：不在桌面上的组先整桌换过去，已关闭的钉回，钉着的提到最前。 */
export function showGroupMember(groupId: string, memberId: string): Promise<void> {
  return invoke<void>(desk("show_group_member"), { groupId, memberId });
}

/** 移出桌面上参考组里没钉着的成员，返回移出了几个。撤销用 {@link undoPruneUnpinned}。 */
export function pruneUnpinnedMembers(): Promise<number> {
  return invoke<number>(desk("prune_unpinned_members"));
}

/** 撤销最近一次“移出没钉着的”。 */
export function undoPruneUnpinned(): Promise<void> {
  return invoke<void>(desk("undo_prune_unpinned"));
}

/** 设为常用（排在常用的最后）或取消常用。 */
export function setReferenceGroupFavorite(groupId: string, favorite: boolean): Promise<void> {
  return invoke<void>(desk("set_reference_group_favorite"), { groupId, favorite });
}

/**
 * 加进上一组：桌面上的参考组 `sourceId`（提示所说的新参考组）的成员移进 `targetId`，删掉 `sourceId`，
 * 把 `targetId` 摆上桌面。桌面上已不是 `sourceId` 时什么都不做。
 */
export function foldIntoPrevious(sourceId: string, targetId: string): Promise<void> {
  return invoke<void>(desk("fold_into_previous"), { sourceId, targetId });
}

/**
 * 移到新参考组：桌面上参考组里在本地日期 `day`（`YYYY-MM-DD`）添加的成员移到一个新参考组，
 * 新参考组摆上桌面，原来那组原样留着。
 * 返回新参考组的 id；这一段为空或就是全部成员时为 `null`。撤销用 {@link undoSplitOff}。
 */
export function splitOffReferenceGroup(day: string): Promise<string | null> {
  return invoke<string | null>(desk("split_off_reference_group"), { day });
}

/** 撤销最近一次“移到新参考组”。 */
export function undoSplitOff(): Promise<void> {
  return invoke<void>(desk("undo_split_off"));
}

/** 打开参考组：成员按保存的局部与摆放钉到桌面；返回新钉出的数量。 */
export function openReferenceGroup(groupId: string): Promise<number> {
  return invoke<number>(desk("open_reference_group"), { groupId });
}

export function renameReferenceGroup(groupId: string, name: string): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("rename_reference_group"), { groupId, name });
}

/** 删除参考组（#480）：先暂放在回收位置，返回的内容交给 {@link restoreReferenceGroup} 撤销；提示过期后交给 {@link purgeDeletedReferenceGroup} 真正删除。 */
export function deleteReferenceGroup(groupId: string): Promise<DeletedGroup> {
  return invoke<DeletedGroup>(desk("delete_reference_group"), { groupId });
}

/** 撤销 {@link deleteReferenceGroup}：参考组原样放回，桌面上还在的钉图重新记起自己是哪个成员。 */
export function restoreReferenceGroup(deleted: DeletedGroup): Promise<void> {
  return invoke<void>(desk("restore_reference_group"), { deleted });
}

/** 撤销提示过期：真正删除暂放的参考组。 */
export function purgeDeletedReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("purge_deleted_reference_group"), { groupId });
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
export function importReferenceGroupPackage(
  libraryId: string,
  destination?: SaveDestination,
): Promise<ReferenceGroup | null> {
  const t = testPick<string | null>();
  if (t && t.value === null) return Promise.resolve(null);
  return invoke<ReferenceGroup | null>(desk("import_reference_group_package"), {
    libraryId,
    ...(destination ? { destination } : {}),
    path: t?.value ?? null,
  });
}

/** 参考组有变化（保存、重命名、删除）：重新读取。 */
export function onReferenceGroupsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("reference-groups", () => handler());
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

/** 钉图离屏渲染 vs 正式派生图（#282）：第一次调用时 Rust 在 GPU 上画全部样本。 */
export function gatePins(): Promise<PinGate> {
  return invoke<PinGate>("gate_pins");
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
