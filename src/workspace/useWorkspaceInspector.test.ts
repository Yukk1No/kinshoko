import { afterEach, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowserCard } from "../wall/Wall";
import { useWorkspaceInspector } from "./useWorkspaceInspector";

afterEach(cleanup);

const card = (id: string, libraryId: string) => ({
  id, libraryId, imageId: id, sources: [{ libraryId, libraryName: libraryId, imageId: id, matches: true, unavailable: null, deleted: false }],
}) as unknown as BrowserCard;

function inspector(initial: { selected: string[]; cards: BrowserCard[]; scope?: WorkspaceScope }) {
  return renderHook(({ selected, cards, scope }) => useWorkspaceInspector({
    selected: new Set(selected), setSelected: () => {}, loadedCards: cards, workspaceScope: scope ?? { kind: "all" },
    sources: null, setSources: () => {}, hidden: false, viewing: null,
  }), { initialProps: initial });
}

it("「全部图片」下选中的图只在一个图库时，详情面板整理那个图库", () => {
  const { result } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  expect(result.current.selectionLibrary).toBe("L2");
  expect(result.current.eligible).toBe(true);
});

it("范围是某个图库时就是它", () => {
  const { result } = inspector({ selected: ["a"], cards: [], scope: { kind: "library", libraryId: "L3", scope: { kind: "all" } } });
  expect(result.current.selectionLibrary).toBe("L3");
});

it("列表重读期间选中的图暂时不在已读卡片里：沿用这组选择定下的图库，面板不收起", () => {
  const { result, rerender } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  rerender({ selected: ["a"], cards: [] });
  expect(result.current.selectionLibrary).toBe("L2");
  expect(result.current.eligible).toBe(true);
});

it("没读到过的选择定不下图库，不猜一个", () => {
  const { result, rerender } = inspector({ selected: ["a"], cards: [card("a", "L2")] });
  rerender({ selected: ["b"], cards: [] });
  expect(result.current.selectionLibrary).toBeNull();
  expect(result.current.eligible).toBe(false);
});
