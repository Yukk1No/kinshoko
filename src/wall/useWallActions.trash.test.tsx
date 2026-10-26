import { expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { ToastProvider } from "../ui/Toast";
import type { BrowserCard } from "./Wall";
import { api, calls, card, Harness, named, setupWallActions } from "./useWallActions.fixtures";

/** 移到回收站与还原：一次批量命令、先移走卡片、失败放回（#290）。 */
setupWallActions();

const EDIT_SOURCES = "plugin:library|workspace_edit_sources";
type Target = { libraryId: string; imageId: string; contentId: string };
const targetsOf = (call: { args: Record<string, unknown> }) => call.args.targets as Target[];
/** 批量整理命令：这些图库失败（按图库返回原因），其余照常完成。 */
const failing = (reasons: Record<string, string>) => mockIPC((cmd, args) => {
  calls.push({ cmd, args: args as Record<string, unknown> });
  if (cmd !== EDIT_SOURCES) return null;
  const libraries = [...new Set((args as { targets: Target[] }).targets.map((t) => t.libraryId))];
  return libraries.filter((id) => id in reasons).map((libraryId) => ({ libraryId, error: reasons[libraryId] }));
});

it("移到回收站不先确认，轻提示里的“撤销”把同一批图还原，各一次批量调用", async () => {
  failing({});
  render(<ToastProvider><Harness /></ToastProvider>);
  act(() => api.edit([card("1"), card("2", "L2")], [{ kind: "delete" }], true));
  expect(await screen.findByText("已移到回收站")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  const edits = () => calls.filter((c) => c.cmd === EDIT_SOURCES);
  await waitFor(() => expect(edits()).toHaveLength(2));
  expect([targetsOf(edits()[1]), edits()[1].args.edits]).toEqual([
    [{ libraryId: "L1", imageId: "i1", contentId: "1" }, { libraryId: "L2", imageId: "i2", contentId: "2" }],
    [{ kind: "restore" }],
  ]);
});

it("跨图库移到回收站时一个图库失败：已移走的那部分照样能撤销", async () => {
  failing({ L2: "资料库暂时不可用" });
  const onError = vi.fn();
  render(<ToastProvider><Harness onError={onError} /></ToastProvider>);
  act(() => api.edit([card("1"), card("2", "L2"), card("3", "L3")], [{ kind: "delete" }], true));
  expect(await screen.findByText("已移到回收站")).toBeTruthy();
  expect(screen.getByText("2 张")).toBeTruthy();
  expect(onError).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  const restores = () => calls.filter((c) => c.cmd === EDIT_SOURCES && (c.args.edits as { kind: string }[])[0].kind === "restore");
  await waitFor(() => expect(restores()).toHaveLength(1));
  expect(targetsOf(restores()[0]).map((t) => t.libraryId)).toEqual(["L1", "L3"]);
});

it("一次删除 N 张图只调一次批量命令，带上每张图的来源；结束后刷新，clear 时取消选择（#290）", async () => {
  failing({});
  const onChanged = vi.fn(), onClearSelection = vi.fn();
  render(<Harness onChanged={onChanged} onClearSelection={onClearSelection} />);
  act(() => api.edit([card("1"), card("2", "L2"), card("3")], [{ kind: "delete" }], true));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const edits = calls.filter((c) => c.cmd === EDIT_SOURCES);
  expect(edits).toHaveLength(1);
  expect(targetsOf(edits[0])).toEqual([
    { libraryId: "L1", imageId: "i1", contentId: "1" }, { libraryId: "L2", imageId: "i2", contentId: "2" },
    { libraryId: "L1", imageId: "i3", contentId: "3" },
  ]);
  expect(edits[0].args.edits).toEqual([{ kind: "delete" }]);
  expect(calls.some((c) => c.cmd === "plugin:library|workspace_edit_source")).toBe(false);
  expect(onClearSelection).toHaveBeenCalled();
});

it("点删除后先移走卡片，不等后端；失败的图库那部分放回原位并给出原因（#290）", async () => {
  let answer: ((failed: { libraryId: string; error: string }[]) => void) | undefined;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return cmd === EDIT_SOURCES ? new Promise((resolve) => { answer = resolve; }) : null;
  });
  const putBack = vi.fn();
  const removeCards = vi.fn((_cards: BrowserCard[]) => putBack);
  const onError = vi.fn(), onChanged = vi.fn();
  render(<Harness removeCards={removeCards} onError={onError} onChanged={onChanged} />);
  const cards = [named("1", "L1", "工作参考"), named("2", "L2", "私人收藏"), named("3", "L2", "私人收藏")];
  act(() => api.edit(cards, [{ kind: "delete" }], true));
  expect(removeCards).toHaveBeenCalledWith(cards);
  expect(onChanged).not.toHaveBeenCalled();
  await waitFor(() => expect(answer).toBeTypeOf("function"));
  await act(async () => answer!([{ libraryId: "L2", error: "资料库暂时不可用" }]));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(putBack).toHaveBeenCalledWith([cards[1], cards[2]]);
  expect(onError).toHaveBeenCalledWith("有图库没有整理完。「私人收藏」：资料库暂时不可用");
});

it("另一个资料库里那份来源仍在视图里的卡片不先移走：删的只是显示的这份", async () => {
  failing({});
  const removeCards = vi.fn((_cards: BrowserCard[]) => () => {});
  render(<Harness removeCards={removeCards} />);
  const source = (libraryId: string, imageId: string) => ({ libraryId, libraryName: libraryId, imageId, unavailable: null, matches: true, deleted: false });
  const shared: BrowserCard = { ...card("1"), sources: [source("L1", "i1"), source("L2", "j1")] };
  const only: BrowserCard = { ...card("2"), sources: [source("L1", "i2")] };
  act(() => api.edit([shared, only], [{ kind: "delete" }], false));
  expect(removeCards).toHaveBeenCalledWith([only]);
});

it("批量命令整个失败时全部放回并给出原因；不移走卡片的整理不先移走", async () => {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return cmd === EDIT_SOURCES ? Promise.reject("安全模式刚切换") : null;
  });
  const putBack = vi.fn();
  const removeCards = vi.fn((_cards: BrowserCard[]) => putBack);
  const onError = vi.fn(), onChanged = vi.fn(), onClearSelection = vi.fn();
  render(<Harness removeCards={removeCards} onError={onError} onChanged={onChanged} onClearSelection={onClearSelection} />);
  const cards = [card("1"), card("2", "L2")];
  act(() => api.edit(cards, [{ kind: "delete" }], true));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(putBack).toHaveBeenCalledWith(cards);
  expect(onError).toHaveBeenCalledWith("没有整理完：安全模式刚切换");
  expect(onClearSelection).not.toHaveBeenCalled();

  removeCards.mockClear();
  act(() => api.edit(cards, [{ kind: "setRating", rating: "general" }], false));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  expect(removeCards).not.toHaveBeenCalled();
});

