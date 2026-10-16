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
    onClearSelection: () => {}, onError: () => {}, importFrom: () => {}, selectAll: () => {}, setDensity: () => {}, ...options,
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
