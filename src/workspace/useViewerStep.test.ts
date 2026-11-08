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
