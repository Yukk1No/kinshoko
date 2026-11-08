import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { Wall } from "./Wall";
import { workspaceCard } from "../test/workspacePage";
import type { WorkspacePage } from "../bindings/WorkspacePage";

// 同一图集叠成一摞，点开原位托盘（#418 第 5 版原型）。
let requests: { stackSets: boolean }[] = [];
/** 第二摞（两页）接在后面；第 2 页往后里成人内容的页。 */
let secondSet = false;
let adultPages = new Set<string>();
const page = (id: string) => workspaceCard({ id, width: 100, height: 120, adult: adultPages.has(id) });
function browse(stackSets: boolean): WorkspacePage {
  const set = { key: "pixiv:9", pages: [page("p0"), page("p1"), page("p2")] };
  const cards = stackSets
    ? [page("a"), { ...page("p0"), set }, page("b")]
    : [page("a"), page("p0"), page("p1"), page("p2"), page("b")];
  if (secondSet && stackSets) cards.push({ ...page("q0"), set: { key: "pixiv:10", pages: [page("q0"), page("q1")] } });
  return { cards, total: cards.length, nextCursor: null, status: { revision: "r", libraries: [] }, ...(stackSets ? { images: 5 } : {}) };
}
beforeEach(() => {
  localStorage.clear();
  requests = [];
  secondSet = false;
  adultPages = new Set();
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

function Harness({ stackSets = true, safeMode = false, onSelection, onOpen }: { stackSets?: boolean; safeMode?: boolean; onSelection?: (ids: string[]) => void; onOpen?: (id: string) => void }) {
  const [selected, setSelected] = useState(new Set<string>());
  return <Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={selected} stackSets={stackSets} safeMode={safeMode}
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

it("点张数在原位打开托盘，各页按页序排进去；托盘里的页不带张数，也不带页码", async () => {
  render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  expect(tray()).not.toBeNull();
  expect(shownIds()).toEqual(["a", "p0", "p1", "p2", "b"]);
  expect(card("p0")!.querySelector(".stack-sheet")).toBeNull();
  expect(document.querySelector(".card-count")).toBeNull();
  expect(document.querySelector(".card-page")).toBeNull();
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

it("顶栏报的是张数，不是格数：一摞里的页都算上", async () => {
  const onTotal = vi.fn();
  render(<Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={new Set()} stackSets
    onSelectionChange={() => {}} onOpenImage={() => {}} viewerOpen={false} onTotalChange={onTotal} />);
  await screen.findAllByRole("option");
  expect(onTotal).toHaveBeenLastCalledWith(5);
});

it("从一个托盘直接点另一摞的张数：旧托盘里第 2 页往后的选择随之取消", async () => {
  secondSet = true;
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  fireEvent.click(card("p1")!);
  expect(onSelection).toHaveBeenLastCalledWith(["p1"]);
  fireEvent.click(screen.getByRole("button", { name: "2 张" }));
  expect(onSelection).toHaveBeenLastCalledWith([]);
  expect(shownIds()).toEqual(["a", "p0", "b", "q0", "q1"]);
});

it("记住的滚动位置落在托盘里的页上时，记成这一摞：下次进来托盘是关着的", async () => {
  // 墙窄到托盘里一行只放得下一页：第 3 页单独成行。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 260 });
  const { unmount } = render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  const wall = document.querySelector<HTMLElement>(".wall")!;
  expect(parseFloat(card("p2")!.style.top)).toBeGreaterThan(parseFloat(card("p0")!.style.top));
  wall.scrollTop = parseFloat(card("p2")!.style.top) - 4;
  fireEvent.scroll(wall);
  unmount();
  expect(JSON.parse(localStorage.getItem('kinshoko.wall.workspace.{"kind":"all"}')!)).toMatchObject({ id: "p0" });
});

it("安全模式下，一摞里成人内容的页在纸上也遮着，封面不是成人内容也一样", async () => {
  adultPages = new Set(["p1"]);
  render(<Harness safeMode />);
  await screen.findAllByRole("option");
  const sheets = [...card("p0")!.querySelectorAll<HTMLElement>(".stack-sheet")];
  expect(sheets.map((sheet) => sheet.dataset.veiled)).toEqual(["false", "true"]);
});

it("安全模式关着时，托盘里成人内容的页随墙上的图一起放出，不一直遮着", async () => {
  adultPages = new Set(["p1"]);
  render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  await vi.waitFor(() => expect(card("p1")!.dataset.veiled).toBe("false"));
});

it("焦点在托盘里时按 Esc 关托盘，焦点回到这一摞，回车还能再打开", async () => {
  render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  card("p2")!.focus();
  fireEvent.keyDown(card("p2")!, { key: "Escape" });
  expect(tray()).toBeNull();
  expect(document.activeElement).toBe(card("p0"));
  fireEvent.keyDown(card("p0")!, { key: "Enter" });
  expect(tray()).not.toBeNull();
});

it("关托盘时飞回的影子也按安全模式遮：成人内容的页不露图", async () => {
  adultPages = new Set(["p1"]);
  const flight = { cancel() {}, onfinish: null, oncancel: null };
  HTMLElement.prototype.animate = vi.fn(() => flight) as never;
  try {
    render(<Harness safeMode />);
    await screen.findAllByRole("option");
    fireEvent.click(count());
    fireEvent.keyDown(card("p1")!, { key: "Escape" });
    const ghosts = [...document.querySelectorAll<HTMLElement>(".tray-ghost")];
    expect(ghosts.map((ghost) => ghost.dataset.veiled)).toEqual(["false", "true"]);
    expect(ghosts[1].style.backgroundImage).toBe("");
  } finally {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
});

it("焦点在页角的勾上时，Esc 与 Ctrl+A 照常落到托盘：先取消页的选择，Ctrl+A 只选这一摞", async () => {
  const onSelection = vi.fn();
  render(<Harness onSelection={onSelection} />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  const check = screen.getByRole("checkbox", { name: "第 2 页" });
  fireEvent.click(check);
  expect(onSelection).toHaveBeenLastCalledWith(["p1"]);
  fireEvent.keyDown(check, { key: "a", ctrlKey: true });
  expect(onSelection).toHaveBeenLastCalledWith(["p0", "p1", "p2"]);
  fireEvent.keyDown(check, { key: "Escape" });
  expect(onSelection).toHaveBeenLastCalledWith([]);
  expect(tray()).not.toBeNull();
});

it("从一个托盘直接换到下一摞：被点的那一摞留在屏幕原处，不按旧托盘里的页去找位置", async () => {
  secondSet = true;
  // 墙窄到一行只放一页：托盘很长，滚到下一摞时视口顶上是旧托盘里的页。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 260 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });
  render(<Harness />);
  await screen.findAllByRole("option");
  fireEvent.click(count());
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = parseFloat(card("p2")!.style.top) + 10;
  fireEvent.scroll(wall);
  const before = parseFloat(card("q0")!.style.top) - wall.scrollTop;
  fireEvent.click(screen.getByRole("button", { name: "2 张" }));
  const after = parseFloat(card("q0")!.style.top) - wall.scrollTop;
  expect(Math.abs(after - before)).toBeLessThan(40);
});

it("关着叠放时记下的位置落在一摞的第 2 页往后：打开叠放后回到这一摞", async () => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 260 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  localStorage.setItem('kinshoko.wall.workspace.{"kind":"all"}', JSON.stringify({ id: "p2", delta: 0 }));
  render(<Harness />);
  await screen.findAllByRole("option");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  await vi.waitFor(() => expect(wall.scrollTop).toBeCloseTo(parseFloat(card("p0")!.style.top), 0));
  expect(wall.scrollTop).toBeGreaterThan(0);
});
