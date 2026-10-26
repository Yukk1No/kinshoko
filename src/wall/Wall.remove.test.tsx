import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import { Wall, type WallHandle } from "./Wall";

const card = (id: string): WorkspaceCard => ({ id, width: 120, height: 90, adult: false, thumbnail: `A/${id}/256`,
  libraryId: "A", imageId: id, sources: [] });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
let browses = 0;
beforeEach(() => {
  browses = 0;
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((command) => {
    if (command !== "plugin:library|workspace_browse") throw new Error(command);
    browses += 1;
    const cards = ["a", "b", "c", "d"].map(card);
    return { cards, total: cards.length, nextCursor: null, status: { revision: "r", libraries: [] } } satisfies WorkspacePage;
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

const shown = () => [...document.querySelectorAll<HTMLElement>(".card")].map((node) => node.dataset.id);
const total = () => document.querySelector<HTMLElement>(".wall")?.dataset.total;

it("先移走卡片，不等重新浏览；放回的那部分回到原位（#290）", async () => {
  const ref = createRef<WallHandle>();
  render(<Wall ref={ref} libraryId="A" scope={{ kind: "all" }} selected={new Set()} onSelectionChange={() => {}}
    onOpenImage={() => {}} viewerOpen={false} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  expect(shown()).toEqual(["a", "b", "c", "d"]);
  let putBack!: (ids: string[]) => void;
  act(() => { putBack = ref.current!.remove(["b", "d"]); });
  expect(shown()).toEqual(["a", "c"]);
  expect(total()).toBe("2");
  act(() => putBack(["b"]));
  expect(shown()).toEqual(["a", "b", "c"]);
  expect(total()).toBe("3");
  act(() => putBack(["b"]));
  expect(shown()).toEqual(["a", "b", "c"]);
  expect(browses).toBe(1);
});

it("只放回后面那张时也回到原位：前面那张已移走也不乱序", async () => {
  const ref = createRef<WallHandle>();
  render(<Wall ref={ref} libraryId="A" scope={{ kind: "all" }} selected={new Set()} onSelectionChange={() => {}}
    onOpenImage={() => {}} viewerOpen={false} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  let first!: (ids: string[]) => void, second!: (ids: string[]) => void;
  act(() => { first = ref.current!.remove(["b", "c"]); });
  act(() => first(["c"]));
  expect(shown()).toEqual(["a", "c", "d"]);
  // 两次删除重叠、都失败：各自放回后仍是原来的先后。
  act(() => { first = ref.current!.remove(["a"]); });
  act(() => { second = ref.current!.remove(["c"]); });
  act(() => first(["a"]));
  act(() => second(["c"]));
  expect(shown()).toEqual(["a", "c", "d"]);
});

it("移走时还在路上的下一页回来也不把移走的卡片带回来（#290）", async () => {
  // 第一页取满一整页（PAGE = 500），下一页才由 loadMore 去取。
  const first = Array.from({ length: 500 }, (_, i) => card(`p${i}`));
  let second: ((page: WorkspacePage) => void) | undefined;
  mockIPC((command, args) => {
    if (command !== "plugin:library|workspace_browse") throw new Error(command);
    const cursor = (args as { query: { cursor: string | null } }).query.cursor;
    if (cursor === null) return { cards: first, total: 501, nextCursor: "p2", status: { revision: "r", libraries: [] } } satisfies WorkspacePage;
    return new Promise<WorkspacePage>((resolve) => { second = resolve; });
  });
  const ref = createRef<WallHandle>();
  render(<Wall ref={ref} libraryId="A" scope={{ kind: "all" }} selected={new Set()} onSelectionChange={() => {}}
    onOpenImage={() => {}} viewerOpen={false} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  expect(total()).toBe("501");
  act(() => ref.current!.loadMore());
  await settle();
  expect(second).toBeTypeOf("function");
  act(() => { ref.current!.remove(["p0"]); });
  await act(async () => second!({ cards: [card("last")], total: 501, nextCursor: null, status: { revision: "r", libraries: [] } }));
  expect(shown()).not.toContain("p0");
  expect(total()).toBe("500");
});

it("全部移走再全部放回仍按原来的先后，几千张也不卡住", async () => {
  const many = Array.from({ length: 2400 }, (_, i) => `c${i}`);
  mockIPC(() => ({ cards: many.map(card), total: many.length, nextCursor: null, status: { revision: "r", libraries: [] } }) satisfies WorkspacePage);
  const ref = createRef<WallHandle>();
  render(<Wall ref={ref} libraryId="A" scope={{ kind: "all" }} selected={new Set()} onSelectionChange={() => {}}
    onOpenImage={() => {}} viewerOpen={false} reloadKey={0} workspaceScope={{ kind: "all" }} safeMode />);
  await settle();
  let putBack!: (ids: string[]) => void;
  act(() => { putBack = ref.current!.remove(many); });
  expect(total()).toBe("0");
  const started = performance.now();
  act(() => putBack([...many].reverse()));
  expect(performance.now() - started).toBeLessThan(1500);
  expect(total()).toBe("2400");
  expect(shown().slice(0, 3)).toEqual(["c0", "c1", "c2"]);
});

it("整理还没结束时不翻下一页，重新浏览回来的页也去掉移走的卡片与张数；结束后照常翻页（#290）", async () => {
  const first = Array.from({ length: 500 }, (_, i) => card(`p${i}`));
  const nextPages: string[] = [];
  mockIPC((command, args) => {
    if (command !== "plugin:library|workspace_browse") throw new Error(command);
    const cursor = (args as { query: { cursor: string | null } }).query.cursor;
    if (cursor !== null) nextPages.push(cursor);
    // 后端还没删完：张数与第一页都还算着 p0。
    return cursor === null
      ? { cards: first, total: 501, nextCursor: "p2", status: { revision: "r", libraries: [] } } satisfies WorkspacePage
      : { cards: [card("last")], total: 501, nextCursor: null, status: { revision: "r", libraries: [] } } satisfies WorkspacePage;
  });
  const ref = createRef<WallHandle>();
  const props = { libraryId: "A", scope: { kind: "all" as const }, selected: new Set<string>(), onSelectionChange: () => {},
    onOpenImage: () => {}, viewerOpen: false, workspaceScope: { kind: "all" as const }, safeMode: true };
  const view = render(<Wall ref={ref} {...props} reloadKey={0} />);
  await settle();
  let done!: (ids: string[]) => void;
  act(() => { done = ref.current!.remove(["p0"]); });
  act(() => ref.current!.loadMore());
  await settle();
  expect(nextPages).toEqual([]);
  view.rerender(<Wall ref={ref} {...props} reloadKey={1} />);
  await settle();
  expect(shown()).not.toContain("p0");
  expect(total()).toBe("500");
  act(() => done([]));
  act(() => ref.current!.loadMore());
  await settle();
  expect(nextPages).toEqual(["p2"]);
});
