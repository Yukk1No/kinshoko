import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { PIN_LIMIT, staggeredPins, useWallActions, type WallActionsOptions } from "./useWallActions";
import type { WallMenuActions } from "./WallMenu";
import type { BrowserCard } from "./Wall";

const card = (id: string, libraryId = "L1"): BrowserCard => ({
  id, width: 100, height: 100, thumbnail: "", adult: false, libraryId, imageId: `i${id}`, sources: [],
});
let calls: { cmd: string; args: Record<string, unknown> }[];
beforeEach(() => {
  calls = [];
  mockIPC((cmd, args) => { calls.push({ cmd, args: args as Record<string, unknown> }); return null; });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

it("多张钉住从指针位置起错开排列（窗口客户区物理像素）", () => {
  const rects = staggeredPins({ x: 100, y: 50 }, 3, 2);
  expect(rects.map((r) => [r.x + r.width / 2, r.y + r.height / 2])).toEqual([[200, 100], [256, 156], [312, 212]]);
  expect(PIN_LIMIT).toBe(20);
});

let api: WallMenuActions;
function Harness(options: Partial<WallActionsOptions>) {
  const { actions, dialogs } = useWallActions({
    safe: false, activeLibraryId: "L1", onOpen: () => {}, onCrop: () => {}, onInspect: () => {}, onChanged: () => {},
    onClearSelection: () => {}, onError: () => {}, importFrom: () => {}, selectAll: () => {}, setDensity: () => {},
    onNotice: () => {}, importClipboard: async () => {}, ...options,
  });
  api = actions;
  return <>{dialogs}</>;
}
const pins = () => calls.filter((c) => c.cmd === "plugin:desktop|pin_reference");

it("不超过 20 张时直接钉住，每张按来源钉", async () => {
  render(<Harness />);
  act(() => api.pin([card("1"), card("2", "L2")], { x: 10, y: 10 }));
  await waitFor(() => expect(pins()).toHaveLength(2));
  expect(pins().map((c) => [c.args.libraryId, c.args.imageId, c.args.crop])).toEqual([["L1", "i1", null], ["L2", "i2", null]]);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("超过 20 张先确认，确认后只钉前 20 张；取消则不钉", async () => {
  const many = Array.from({ length: 23 }, (_, i) => card(String(i)));
  render(<Harness />);
  act(() => api.pin(many, { x: 0, y: 0 }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("23");
  expect(pins()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(pins()).toHaveLength(0);
  act(() => api.pin(many, { x: 0, y: 0 }));
  fireEvent.click(await screen.findByRole("button", { name: "钉住前 20 张" }));
  await waitFor(() => expect(pins()).toHaveLength(20));
  expect(pins().map((c) => c.args.imageId)).toEqual(many.slice(0, 20).map((c) => c.imageId));
});

it("整理按每张图的来源写入，结束后刷新；clear 时取消选择", async () => {
  const onChanged = vi.fn(), onClearSelection = vi.fn();
  render(<Harness onChanged={onChanged} onClearSelection={onClearSelection} />);
  act(() => api.edit([card("1"), card("2", "L2")], [{ kind: "delete" }], true));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const edits = calls.filter((c) => c.cmd === "plugin:library|workspace_edit_source");
  expect(edits.map((c) => c.args.target)).toEqual([
    { libraryId: "L1", imageId: "i1", contentId: "1" }, { libraryId: "L2", imageId: "i2", contentId: "2" },
  ]);
  expect(edits[0].args.edits).toEqual([{ kind: "delete" }]);
  expect(onClearSelection).toHaveBeenCalled();
});

it("复制图片按卡片显示的来源复制原图，成功后轻提示（#105）", async () => {
  const onNotice = vi.fn(), onError = vi.fn();
  render(<Harness onNotice={onNotice} onError={onError} />);
  act(() => api.copy(card("2", "L2")));
  await waitFor(() => expect(onNotice).toHaveBeenCalledWith("已复制图片"));
  expect(calls.filter((c) => c.cmd === "plugin:desktop|copy_reference_image").map((c) => c.args)).toEqual([{ libraryId: "L2", imageId: "i2" }]);
  expect(onError).not.toHaveBeenCalled();
});

it("复制失败或原文件不在时给出原因，不静默失败", async () => {
  mockIPC((cmd) => {
    if (cmd === "plugin:desktop|copy_reference_image" || cmd === "plugin:desktop|reveal_reference_image") throw "原文件不在了，可能被移走或删除：C:/lib/originals/a.png";
    return null;
  });
  const onNotice = vi.fn(), onError = vi.fn();
  render(<Harness onNotice={onNotice} onError={onError} />);
  act(() => api.copy(card("1")));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("无法复制图片：原文件不在了，可能被移走或删除：C:/lib/originals/a.png"));
  act(() => api.reveal(card("1")));
  await waitFor(() => expect(onError).toHaveBeenLastCalledWith("无法在资源管理器中显示：原文件不在了，可能被移走或删除：C:/lib/originals/a.png"));
  expect(onNotice).not.toHaveBeenCalled();
});

it("在资源管理器中显示按卡片显示的来源定位原文件", async () => {
  const onError = vi.fn();
  render(<Harness onError={onError} />);
  act(() => api.reveal(card("1")));
  await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:desktop|reveal_reference_image")).toBe(true));
  expect(calls.find((c) => c.cmd === "plugin:desktop|reveal_reference_image")!.args).toEqual({ libraryId: "L1", imageId: "i1" });
  expect(onError).not.toHaveBeenCalled();
});

it("从剪贴板导入交给导入入口，剪贴板是否有图片读后端", async () => {
  mockIPC((cmd) => cmd === "plugin:desktop|clipboard_has_image" ? false : null);
  const importClipboard = vi.fn(async () => {});
  render(<Harness importClipboard={importClipboard} />);
  await expect(api.clipboardHasImage()).resolves.toBe(false);
  act(() => api.importClipboard());
  expect(importClipboard).toHaveBeenCalled();
});

it("从剪贴板导入失败（剪贴板没有图片）时给出原因", async () => {
  const onError = vi.fn();
  render(<Harness onError={onError} importClipboard={() => Promise.reject("剪贴板里没有图片")} />);
  act(() => api.importClipboard());
  await waitFor(() => expect(onError).toHaveBeenCalledWith("剪贴板里没有图片"));
});

it("加入参考组按每张图的来源加入", async () => {
  render(<Harness />);
  act(() => api.addToGroup([card("1")], "g1"));
  await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:library|workspace_source_group")).toBe(true));
  const call = calls.find((c) => c.cmd === "plugin:library|workspace_source_group")!;
  expect(call.args).toMatchObject({ target: { libraryId: "L1", imageId: "i1", contentId: "1" }, groupId: "g1" });
});

const named = (id: string, libraryId: string, libraryName: string): BrowserCard => ({
  ...card(id, libraryId),
  sources: [{ libraryId, libraryName, imageId: `i${id}`, unavailable: null, matches: true, deleted: true }],
} as BrowserCard);

it("一张图的彻底删除按它显示的来源预览并确认", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd.endsWith("workspace_preview_source_delete")) return { imageIds: ["i1"], groups: [], token: "t" };
    return null;
  });
  render(<Harness />);
  act(() => api.purge([card("1")]));
  fireEvent.click(await screen.findByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:library|workspace_permanent_source_delete")).toBe(true));
  expect(calls.find((c) => c.cmd === "plugin:library|workspace_permanent_source_delete")!.args).toMatchObject({ target: { libraryId: "L1", imageId: "i1" }, token: "t" });
});

it("跨图库的多张彻底删除：按图库分组预览，列出受影响的参考组，确认后逐组删除（#112）", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "plugin:library|preview_permanent_delete_batch") return [
      { libraryId: "L1", preview: { imageIds: ["i1"], groups: [{ groupId: "g", name: "姿势", imageIds: ["i1"] }], token: "t1" }, error: null },
      { libraryId: "L2", preview: { imageIds: ["i2", "i3"], groups: [], token: "t2" }, error: null },
    ];
    if (cmd === "plugin:library|permanent_delete_batch") return [];
    return null;
  });
  const onClearSelection = vi.fn(), onChanged = vi.fn(), onError = vi.fn();
  render(<Harness onClearSelection={onClearSelection} onChanged={onChanged} onError={onError} />);
  act(() => api.purge([named("1", "L1", "工作参考"), named("2", "L2", "私人收藏"), named("3", "L2", "私人收藏")]));
  expect(await screen.findByText("永久删除这 3 张图？原图与整理结果都会删除，无法恢复。")).toBeTruthy();
  expect(screen.getByText("姿势（1 张）")).toBeTruthy();
  expect(calls.find((c) => c.cmd === "plugin:library|preview_permanent_delete_batch")!.args).toEqual({ targets: [
    { libraryId: "L1", imageId: "i1" }, { libraryId: "L2", imageId: "i2" }, { libraryId: "L2", imageId: "i3" },
  ] });
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(onClearSelection).toHaveBeenCalled());
  expect(calls.find((c) => c.cmd === "plugin:library|permanent_delete_batch")!.args).toEqual({ groups: [
    { libraryId: "L1", imageIds: ["i1"], token: "t1" }, { libraryId: "L2", imageIds: ["i2", "i3"], token: "t2" },
  ] });
  expect(onChanged).toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("某个图库断连时其他图库照常删除，并按图库报告没完成的原因（#112）", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "plugin:library|preview_permanent_delete_batch") return [
      { libraryId: "L1", preview: { imageIds: ["i1"], groups: [], token: "t1" }, error: null },
      { libraryId: "L2", preview: null, error: "资料库暂时不可用：E:\\私人收藏" },
      { libraryId: "L3", preview: { imageIds: ["i3"], groups: [], token: "t3" }, error: null },
    ];
    if (cmd === "plugin:library|permanent_delete_batch") return [{ libraryId: "L3", error: "导入收尾失败" }];
    return null;
  });
  const onError = vi.fn(), onChanged = vi.fn();
  render(<Harness onError={onError} onChanged={onChanged} />);
  act(() => api.purge([named("1", "L1", "工作参考"), named("2", "L2", "私人收藏"), named("3", "L3", "移动盘")]));
  expect(await screen.findByText("永久删除这 2 张图？原图与整理结果都会删除，无法恢复。")).toBeTruthy();
  expect(screen.getByText("「私人收藏」的 1 张这次删不了：资料库暂时不可用：E:\\私人收藏")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(calls.find((c) => c.cmd === "plugin:library|permanent_delete_batch")!.args).toEqual({ groups: [
    { libraryId: "L1", imageIds: ["i1"], token: "t1" }, { libraryId: "L3", imageIds: ["i3"], token: "t3" },
  ] });
  expect(onError).toHaveBeenCalledWith("有图库没有删完。「私人收藏」：资料库暂时不可用：E:\\私人收藏；「移动盘」：导入收尾失败");
  expect(onChanged).toHaveBeenCalled();
});

it("是否直接在文件夹里按卡片显示的来源读详情的文件夹（不算子文件夹）", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "plugin:library|workspace_image") return { folders: [{ id: "f9", name: "手部" }] };
    return null;
  });
  render(<Harness />);
  await expect(api.inFolder(card("1", "L2"), "f9")).resolves.toBe(true);
  await expect(api.inFolder(card("1", "L2"), "f1")).resolves.toBe(false);
  expect(calls.find((c) => c.cmd === "plugin:library|workspace_image")!.args).toEqual({ libraryId: "L2", imageId: "i1" });
});

it("部分图库已删除、其他图库预览过期时取消重新列出：已删的图照样刷新并取消选择", async () => {
  const stale = "回收站或参考组在确认前有变化，请重新查看将受影响的参考组";
  let previews = 0;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === "plugin:library|preview_permanent_delete_batch") {
      previews += 1;
      return previews === 1
        ? [
          { libraryId: "L1", preview: { imageIds: ["i1"], groups: [], token: "t1" }, error: null },
          { libraryId: "L2", preview: { imageIds: ["i2"], groups: [], token: "t2" }, error: null },
        ]
        : [{ libraryId: "L2", preview: { imageIds: ["i2"], groups: [], token: "t2b" }, error: null }];
    }
    if (cmd === "plugin:library|permanent_delete_batch") return [{ libraryId: "L2", error: stale }];
    return null;
  });
  const onClearSelection = vi.fn(), onChanged = vi.fn();
  render(<Harness onClearSelection={onClearSelection} onChanged={onChanged} />);
  act(() => api.purge([named("1", "L1", "工作参考"), named("2", "L2", "私人收藏")]));
  fireEvent.click(await screen.findByRole("button", { name: "确认永久删除" }));
  expect(await screen.findByText("回收站或参考组刚有变化，已按最新情况重新列出。")).toBeTruthy();
  await screen.findByText("永久删除这 1 张图？原图与整理结果都会删除，无法恢复。");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(onClearSelection).toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("跨图库的整理与加入参考组：一个图库失败时其他图库照常完成，按图库报告（#112）", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    const target = (args as { target?: { libraryId: string } }).target;
    if (target?.libraryId === "L2") return Promise.reject("资料库暂时不可用");
    return null;
  });
  const onError = vi.fn(), onChanged = vi.fn();
  render(<Harness onError={onError} onChanged={onChanged} />);
  act(() => api.edit([named("1", "L1", "工作参考"), named("2", "L2", "私人收藏"), named("3", "L3", "移动盘")], [{ kind: "delete" }], false));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(calls.filter((c) => c.cmd === "plugin:library|workspace_edit_source").map((c) => (c.args.target as { libraryId: string }).libraryId)).toEqual(["L1", "L2", "L3"]);
  expect(onError).toHaveBeenCalledWith("有图库没有整理完。「私人收藏」：资料库暂时不可用");

  onError.mockClear();
  act(() => api.addToGroup([named("1", "L1", "工作参考"), named("2", "L2", "私人收藏"), named("3", "L3", "移动盘")], "g1"));
  await waitFor(() => expect(onError).toHaveBeenCalled());
  expect(calls.filter((c) => c.cmd === "plugin:library|workspace_source_group").map((c) => (c.args.target as { libraryId: string }).libraryId)).toEqual(["L1", "L2", "L3"]);
  expect(onError).toHaveBeenCalledWith("有图库没有加入参考组。「私人收藏」：资料库暂时不可用");
});

it("跨图库逐张整理按图库分组：一个图库失败后跳过它剩下的图，不再一张张等超时，其他图库照常完成", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    const target = (args as { target?: { libraryId: string } }).target;
    if (target?.libraryId === "L2") return Promise.reject("等导入收尾超时");
    return null;
  });
  const onError = vi.fn(), onChanged = vi.fn();
  render(<Harness onError={onError} onChanged={onChanged} />);
  const cards = [named("1", "L2", "私人收藏"), named("2", "L1", "工作参考"), named("3", "L2", "私人收藏"), named("4", "L3", "移动盘"), named("5", "L2", "私人收藏"), named("6", "L1", "工作参考")];
  act(() => api.edit(cards, [{ kind: "delete" }], false));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const edits = calls.filter((c) => c.cmd === "plugin:library|workspace_edit_source").map((c) => c.args.target as { libraryId: string; imageId: string });
  expect(edits.map((t) => [t.libraryId, t.imageId])).toEqual([["L2", "i1"], ["L1", "i2"], ["L1", "i6"], ["L3", "i4"]]);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith("有图库没有整理完。「私人收藏」：等导入收尾超时");
});
