import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { workspaceCard } from "../test/workspacePage";
import type { BrowserCard, WallHandle } from "../wall/Wall";
import { useViewerStep } from "./useViewerStep";

// 叠放图集（#418）：墙上一摞只占一格，查看器按全部的图走，序号与张数（resultCount）一致。
const page = (id: string) => workspaceCard({ id, width: 100, height: 120 }) as BrowserCard;
const stack = (key: string, ids: string[]) => ({ ...page(ids[0]), set: { key, pages: ids.map(page) } }) as BrowserCard;

function setup(viewingId: string) {
  const loadedCards = [stack("pixiv:1", ["a0", "a1", "a2"]), stack("pixiv:2", ["b0", "b1", "b2"])];
  const setViewing = vi.fn();
  const loadMore = vi.fn();
  const wall = { current: { loadMore } as unknown as WallHandle };
  const { result } = renderHook(() => useViewerStep({ viewing: page(viewingId), setViewing, loadedCards, resultCount: 6, wall }));
  return { result, setViewing, loadMore };
}

it("查看器按一摞里的各页走：序号算上每一页，从上一摞的最后一页走到下一摞的封面", () => {
  const { result, setViewing } = setup("a2");
  expect(result.current.viewingIndex).toBe(2);
  act(() => result.current.step(1));
  expect(setViewing).toHaveBeenCalledWith(expect.objectContaining({ id: "b0" }));
});

it("走到最后一张图时不再读下一页：序号和张数一致", () => {
  const { result, setViewing, loadMore } = setup("b2");
  expect(result.current.viewingIndex).toBe(5);
  act(() => result.current.step(1));
  expect(setViewing).not.toHaveBeenCalled();
  expect(loadMore).not.toHaveBeenCalled();
});

it("往回走：从下一摞的封面回到上一摞的最后一页", () => {
  const { result, setViewing } = setup("b0");
  expect(result.current.viewingIndex).toBe(3);
  act(() => result.current.step(-1));
  expect(setViewing).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
});

function stepFrom(viewingId: string, loadedCards: BrowserCard[], resultCount: number) {
  const setViewing = vi.fn();
  const wall = { current: { loadMore: vi.fn() } as unknown as WallHandle };
  const hook = renderHook(({ id }) => useViewerStep({ viewing: page(id), setViewing, loadedCards, resultCount, wall }), { initialProps: { id: viewingId } });
  return { ...hook, setViewing };
}

it("从一摞翻完接着墙上的下一格，那一格之后再进下一摞", () => {
  const { result, rerender, setViewing } = stepFrom("a1", [stack("pixiv:1", ["a0", "a1"]), page("c"), stack("pixiv:2", ["b0", "b1"])], 5);
  act(() => result.current.step(1));
  expect(setViewing).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }));
  rerender({ id: "c" });
  act(() => result.current.step(1));
  expect(setViewing).toHaveBeenLastCalledWith(expect.objectContaining({ id: "b0" }));
  expect(result.current.loaded).toBe(5);
});

it("托盘开着时墙上排的是各页，查看器照样按页序走", () => {
  const { result, setViewing } = stepFrom("a2", [page("a0"), page("a1"), page("a2"), stack("pixiv:2", ["b0", "b1"])], 5);
  expect(result.current.viewingIndex).toBe(2);
  act(() => result.current.step(1));
  expect(setViewing).toHaveBeenCalledWith(expect.objectContaining({ id: "b0" }));
});

it("一摞里只有这次浏览能显示的页：被查找或安全模式藏起的页不进序号与张数", () => {
  // 后端只送回能显示的页：pixiv:1 原有 a0–a3，a1 被藏起。
  const { result, setViewing } = stepFrom("a0", [stack("pixiv:1", ["a0", "a2", "a3"]), page("c")], 4);
  act(() => result.current.step(1));
  expect(setViewing).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
  expect(result.current.loaded).toBe(4);
});
