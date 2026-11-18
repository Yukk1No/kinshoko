import type { SaveDestination } from "../bindings/SaveDestination";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GatePlan } from "../bindings/GatePlan";
import type { PinGate } from "../bindings/PinGate";
import type { DeletedGroup } from "../bindings/DeletedGroup";
import type { DeskLists } from "../bindings/DeskLists";
import type { MergeUndo } from "../bindings/MergeUndo";
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

/** 桌面上的参考组（#588）：切换列表（最近用过的在前）与归档（最近保存的在前）。 */
export function deskReferenceGroups(): Promise<DeskLists> {
  return invoke<DeskLists>(desk("desk_reference_groups"));
}

/** 整桌换成参考组 `groupId`，原来那一桌原样留着。 */
export function switchReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("switch_reference_group"), { groupId });
}

/** 换到一张新的空桌：不起名、不落盘，钉上第一张后才出现在切换列表里。 */
export function newReferenceDesk(): Promise<void> {
  return invoke<void>(desk("new_reference_desk"));
}

/** 归档：收出切换列表。归档的正是桌面上那个时，桌面换到最近用过的另一个，没有就换到空桌。 */
export function archiveReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("archive_reference_group"), { groupId });
}

/** 从归档取出：放回切换列表并摆到桌面上，改的是原件。 */
export function unarchiveReferenceGroup(groupId: string): Promise<void> {
  return invoke<void>(desk("unarchive_reference_group"), { groupId });
}

/** 并入（#595）：把参考组 `groupId` 的成员复制到桌面上的参考组并钉出来，来源不变。返回撤销要用的记录。 */
export function mergeReferenceGroup(groupId: string): Promise<MergeUndo> {
  return invoke<MergeUndo>(desk("merge_reference_group"), { groupId });
}

/** 撤销 {@link mergeReferenceGroup}：去掉那次并入的成员和复制来的截图。 */
export function undoMergeReferenceGroup(undo: MergeUndo): Promise<void> {
  return invoke<void>(desk("undo_merge_reference_group"), { undo });
}

export function renameReferenceGroup(groupId: string, name: string): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("rename_reference_group"), { groupId, name });
}

/** 删除参考组（#480）：先暂放在回收位置，返回的内容交给 {@link restoreReferenceGroup} 撤销；提示过期后交给 {@link purgeDeletedReferenceGroup} 真正删除。 */
export function deleteReferenceGroup(groupId: string): Promise<DeletedGroup> {
  return invoke<DeletedGroup>(desk("delete_reference_group"), { groupId });
}

/** 撤销 {@link deleteReferenceGroup}：参考组原样放回；删除时摆在桌面上的，放回桌面。 */
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

/** 参考组有变化（切换、重命名、删除……）：重新读取。 */
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
