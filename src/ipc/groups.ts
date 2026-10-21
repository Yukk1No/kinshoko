import type { SaveDestination } from "../bindings/SaveDestination";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { GatePlan } from "../bindings/GatePlan";
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

/** 把桌面上的资料库钉图存成新的参考组（截图钉图不进组）。 */
export function saveReferenceGroup(name: string, captures: import("../bindings/CaptureChoice").CaptureChoice[] = []): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_reference_group"), { name, captures });
}

/** 把桌面上的资料库钉图存进已有的参考组：来自它的更新原成员，其他的加为新成员。 */
export function savePinsToGroup(groupId: string, captures: import("../bindings/CaptureChoice").CaptureChoice[] = []): Promise<ReferenceGroup> {
  return invoke<ReferenceGroup>(desk("save_pins_to_group"), { groupId, captures });
}

export function groupSaveCaptures(): Promise<CaptureEntry[]> {
  return invoke<CaptureEntry[]>(desk("group_save_captures"));
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
export function onPinNotice(pin: string, handler: (text: string) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<{ pin: string; text: string }>("pin-notice", (e) => {
    if (e.payload.pin === pin) handler(e.payload.text);
  });
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
