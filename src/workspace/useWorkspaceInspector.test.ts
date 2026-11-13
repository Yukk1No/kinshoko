import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowserCard } from "../wall/Wall";
import { useWorkspaceInspector } from "./useWorkspaceInspector";

afterEach(cleanup);

const card = (id: string, libraryId: string) =>
  ({
    id,
    libraryId,
    imageId: id,
    sources: [{ libraryId, libraryName: libraryId, imageId: id, matches: true, unavailable: null, deleted: false }],
  }) as unknown as BrowserCard;

function inspector(initial: { selected: string[]; cards: BrowserCard[]; scope?: WorkspaceScope }) {
  return renderHook(
    ({ selected, cards, scope }) =>
      useWorkspaceInspector({
        selected: new Set(selected),
        setSelected: () => {},
        loadedCards: cards,
        workspaceScope: scope ?? { kind: "all" },
        sources: null,
        setSources: () => {},
        hidden: false,
        viewing: null,
        inspectorShown: true,
        onInspectorShown: () => {},
      }),
    { initialProps: initial },
  );
}

it("「全部图片」下选中的图只在一个图库时，详情面板整理那个图库", () => {
  const { result } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  expect(result.current.selectionLibrary).toBe("L2");
  expect(result.current.eligible).toBe(true);
});

it("范围是某个图库时就是它", () => {
  const { result } = inspector({
    selected: ["a"],
    cards: [],
    scope: { kind: "library", libraryId: "L3", scope: { kind: "all" } },
  });
  expect(result.current.selectionLibrary).toBe("L3");
});

it("列表重读期间选中的图暂时不在已读卡片里：沿用这组选择定下的图库，面板不收起", () => {
  const { result, rerender } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  rerender({ selected: ["a"], cards: [] });
  expect(result.current.selectionLibrary).toBe("L2");
  expect(result.current.eligible).toBe(true);
});

it("重读期间详情面板仍整理这组选择里的图，不变空", () => {
  const { result, rerender } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  rerender({ selected: ["a"], cards: [] });
  expect(result.current.panelIds).toEqual(["a"]);
});

it("修剪掉这组选择后不再沿用读到过的卡片", () => {
  const { result, rerender } = inspector({ selected: ["a", "b"], cards: [card("a", "L2"), card("b", "L2")] });
  rerender({ selected: ["b"], cards: [] });
  expect(result.current.panelIds).toEqual([]);
  expect(result.current.selectionLibrary).toBeNull();
});

it("没读到过的选择定不下图库，不猜一个", () => {
  const { result, rerender } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  rerender({ selected: ["b"], cards: [] });
  expect(result.current.selectionLibrary).toBeNull();
  expect(result.current.eligible).toBe(false);
});

it("查看器走到收在一摞里的页（#418）：详情面板整理正在看的这一页，不是封面；关查看器后选择回到这一摞", () => {
  let selected = new Set(["b"]);
  const setSelected = vi.fn((next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
    selected = typeof next === "function" ? next(selected) : next;
  });
  const stack = {
    ...card("a0", "L1"),
    set: { key: "pixiv:1", pages: [card("a0", "L1"), card("a1", "L1")] },
  } as unknown as BrowserCard;
  const loadedCards = [stack, card("b", "L1")];
  const { result, rerender } = renderHook(
    ({ viewing, chosen }) =>
      useWorkspaceInspector({
        selected: chosen,
        setSelected,
        loadedCards,
        workspaceScope: { kind: "all" },
        sources: null,
        setSources: () => {},
        hidden: false,
        viewing,
        inspectorShown: true,
        onInspectorShown: () => {},
      }),
    { initialProps: { viewing: card("a1", "L1") as BrowserCard | null, chosen: selected } },
  );
  expect([...selected]).toEqual(["a1"]);
  rerender({ viewing: card("a1", "L1"), chosen: selected });
  expect(result.current.panelIds).toEqual(["a1"]);
  rerender({ viewing: null, chosen: selected });
  expect([...selected]).toEqual(["a0"]);
});

it("墙上选中整摞（#418）：详情面板与多选悬浮栏整理它的全部页；查看器里看封面时只整理这一页", () => {
  const stack = {
    ...card("a0", "L1"),
    set: { key: "pixiv:1", pages: [card("a0", "L1"), card("a1", "L1"), card("a2", "L1")] },
  } as unknown as BrowserCard;
  const { result } = inspector({ selected: ["a0", "b"], cards: [stack, card("b", "L1")] });
  expect(result.current.panelIds).toEqual(["a0", "a1", "a2", "b"]);
  expect(result.current.selectionLibrary).toBe("L1");
  const viewed = renderHook(() =>
    useWorkspaceInspector({
      selected: new Set(["a0"]),
      setSelected: () => {},
      loadedCards: [stack],
      workspaceScope: { kind: "all" },
      sources: null,
      setSources: () => {},
      hidden: false,
      viewing: card("a0", "L1"),
      inspectorShown: true,
      onInspectorShown: () => {},
    }),
  );
  expect(viewed.result.current.panelIds).toEqual(["a0"]);
});
