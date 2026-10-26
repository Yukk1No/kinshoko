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
