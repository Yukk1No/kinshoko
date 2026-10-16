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

it("彻底删除先列出受影响的参考组再确认", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd.endsWith("preview_permanent_delete")) return { imageIds: ["i1", "i2"], groups: [], token: "t" };
    return null;
  });
  const onClearSelection = vi.fn();
  render(<Harness onClearSelection={onClearSelection} />);
  act(() => api.purge([card("1"), card("2")]));
  fireEvent.click(await screen.findByRole("button", { name: "确认永久删除" }));
  await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:library|permanent_delete")).toBe(true));
  expect(calls.find((c) => c.cmd === "plugin:library|permanent_delete")!.args).toMatchObject({ libraryId: "L1", ids: ["i1", "i2"], token: "t" });
  await waitFor(() => expect(onClearSelection).toHaveBeenCalled());
});
