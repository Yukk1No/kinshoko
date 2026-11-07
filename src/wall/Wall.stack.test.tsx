import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { Wall } from "./Wall";
import { workspaceCard } from "../test/workspacePage";
import type { WorkspacePage } from "../bindings/WorkspacePage";

// 同一图集叠成一摞，点开原位托盘（#418 第 5 版原型）。
let requests: { stackSets: boolean }[] = [];
const page = (id: string) => workspaceCard({ id, width: 100, height: 120 });
function browse(stackSets: boolean): WorkspacePage {
  const set = { key: "pixiv:9", pages: [page("p0"), page("p1"), page("p2")] };
  const cards = stackSets
    ? [page("a"), { ...page("p0"), set }, page("b")]
    : [page("a"), page("p0"), page("p1"), page("p2"), page("b")];
  return { cards, total: cards.length, nextCursor: null, status: { revision: "r", libraries: [] }, ...(stackSets ? { images: 5 } : {}) };
}
beforeEach(() => {
  localStorage.clear();
  requests = [];
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|workspace_browse") throw new Error(cmd);
    const query = (args as { query: { stackSets: boolean } }).query;
    requests.push(query);
    return browse(query.stackSets);
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

function Harness({ stackSets = true, onSelection, onOpen }: { stackSets?: boolean; onSelection?: (ids: string[]) => void; onOpen?: (id: string) => void }) {
  const [selected, setSelected] = useState(new Set<string>());
  return <Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={selected} stackSets={stackSets}
    onSelectionChange={(next) => { onSelection?.([...next]); setSelected(next); }}
    onOpenImage={(card) => onOpen?.(card.id)} viewerOpen={false} />;
}
const card = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
const shownIds = () => [...document.querySelectorAll<HTMLElement>(".wall-canvas > .card")].map((node) => node.dataset.id);
const count = () => screen.getByRole("button", { name: "3 张" });
const tray = () => document.querySelector(".wall-tray");

it("开关关着时照原样一张张摊开，不请求叠放", async () => {
  render(<Harness stackSets={false} />);
  await screen.findAllByRole("option");
  expect(requests.every((query) => !query.stackSets)).toBe(true);
  expect(shownIds()).toEqual(["a", "p0", "p1", "p2", "b"]);
  expect(screen.queryByRole("button", { name: "3 张" })).toBeNull();
});

it("一摞占一格：封面下露出后面几页，左上角是张数按钮", async () => {
  render(<Harness />);
  await screen.findAllByRole("option");
  expect(requests.every((query) => query.stackSets)).toBe(true);
  expect(shownIds()).toEqual(["a", "p0", "b"]);
  expect(card("p0")!.querySelectorAll(".stack-sheet")).toHaveLength(2);
  expect(count().textContent).toBe("3");
  expect(tray()).toBeNull();
});

it("点张数在原位打开托盘，各页按页序排进去；再点一次张数叠回去", async () => {
  render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  expect(tray()).not.toBeNull();
  expect(shownIds()).toEqual(["a", "p0", "p1", "p2", "b"]);
  expect(card("p0")!.querySelector(".stack-sheet")).toBeNull();
  expect(count().getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(count());
  expect(tray()).toBeNull();
  expect(shownIds()).toEqual(["a", "p0", "b"]);
});

it("单击一摞选中整摞；再单击、双击或回车打开托盘，不进查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("option");
  fireEvent.click(card("p0")!);
  expect(onSelection).toHaveBeenLastCalledWith(["p0"]);
  fireEvent.click(card("p0")!);
  expect(tray()).not.toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

it("托盘里单击一页只选中这一页，双击打开查看器", async () => {
  const onSelection = vi.fn();
  const onOpen = vi.fn();
  render(<Harness onSelection={onSelection} onOpen={onOpen} />);
  await screen.findAllByRole("option");
  fireEvent.keyDown(card("p0")!, { key: "Enter" });
  fireEvent.click(card("p1")!);
  expect(onSelection).toHaveBeenLastCalledWith(["p1"]);
  fireEvent.keyDown(card("p1")!, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("p1");
});

it("焦点在托盘里时 Ctrl+A 只选中这一摞的全部页", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.keyDown(card("p1")!, { key: "a", ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["p0", "p1", "p2"]);
});

it("Esc：有选中的页时先取消选择，再按一次关托盘", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.click(card("p2")!);
  fireEvent.keyDown(card("p2")!, { key: "Escape" });
  expect(onSelection).toHaveBeenLastCalledWith([]);
  expect(tray()).not.toBeNull();
  fireEvent.keyDown(card("p2")!, { key: "Escape" });
  expect(tray()).toBeNull();
});

it("点托盘以外关托盘：点到别的格子时同时选中那一格；点托盘背景只取消页的选择", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.click(card("p1")!);
  fireEvent.click(tray()!);
  expect(onSelection).toHaveBeenLastCalledWith([]);
  expect(tray()).not.toBeNull();
  fireEvent.click(card("b")!);
  expect(tray()).toBeNull();
  expect(onSelection).toHaveBeenLastCalledWith(["b"]);
  fireEvent.click(count());
  await act(async () => { fireEvent.click(document.querySelector(".wall")!); });
  expect(tray()).toBeNull();
});

it("关托盘时第 2 页往后的选择随之取消，操作不会落在看不见的图上", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.click(card("p0")!);
  fireEvent.click(card("p2")!, { ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["p0", "p2"]);
  fireEvent.click(card("b")!, { ctrlKey: true });
  expect(tray()).toBeNull();
  expect(onSelection).toHaveBeenLastCalledWith(["p0", "b"]);
});

it("点顶栏也关托盘", async () => {
  render(<><header className="topbar"><button type="button">导入</button></header><Harness /></>);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.pointerDown(screen.getByRole("button", { name: "导入" }));
  expect(tray()).toBeNull();
});
