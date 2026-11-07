import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Profiler } from "react";
import { workspacePage } from "../test/workspacePage";
import { DRAG_IMAGES, Wall } from "./Wall";

// #102 故事17/18（#109）：滚动时不逐事件渲染、按方向预取缩略图；鼠标滚轮插值。
const decoded = vi.hoisted(() => [] as string[]);
vi.mock("./prefetch", async (original) => ({
  ...(await original<typeof import("./prefetch")>()),
  decodeThumbnail: (url: string) => { decoded.push(url); return Promise.resolve(); },
}));

let reduced: boolean;
beforeEach(() => {
  decoded.length = 0;
  reduced = false;
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1121 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") && reduced, media: query, addEventListener() {}, removeEventListener() {} }));
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|workspace_browse") throw new Error(cmd);
    return workspacePage(Array.from({ length: 400 }, (_, i) => ({ id: String(i), width: 100, height: 100 + (i % 5) * 40 })));
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const props = { workspaceScope: { kind: "all" as const }, scope: { kind: "all" as const }, reloadKey: 0, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };

async function setup() {
  let commits = 0;
  const view = render(<Profiler id="wall" onRender={() => { commits += 1; }}><Wall {...props} /></Profiler>);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  const scrollTo = (top: number) => { wall.scrollTop = top; fireEvent.scroll(wall); };
  return { view, wall, scrollTo, commits: () => commits };
}
const mountedIds = () => [...document.querySelectorAll<HTMLElement>(".wall .card")].map((node) => node.dataset.id!);

it("小幅滚动不重新渲染图片墙；越出已挂载的余量时才换一块，视口里的卡片都在", async () => {
  const { wall, scrollTo, commits } = await setup();
  scrollTo(2000);
  const after = commits();
  const before = mountedIds();
  for (const top of [2040, 2090, 2150, 2200, 1900]) scrollTo(top);
  expect(commits()).toBe(after);
  expect(mountedIds()).toEqual(before);
  scrollTo(4000);
  expect(commits()).toBeGreaterThan(after);
  const inView = [...wall.querySelectorAll<HTMLElement>(".card")].filter((node) => {
    const top = parseFloat(node.style.top);
    return top + parseFloat(node.style.height) > 4000 && top < 4800;
  });
  expect(inView.length).toBeGreaterThan(4);
});

it("向下滚时按距离预取挂载范围下方的缩略图，向上滚时预取上方的", async () => {
  const { scrollTo } = await setup();
  scrollTo(1500);
  await act(async () => {});
  decoded.length = 0;
  scrollTo(3000);
  await act(async () => {});
  const idOf = (url: string) => Number(/L1\/(\d+)\//.exec(url)![1]);
  const down = decoded.map(idOf);
  let mounted = mountedIds().map(Number);
  expect(down.length).toBeGreaterThan(0);
  expect(down.some((id) => mounted.includes(id))).toBe(false);
  // 瀑布流按序号放进最短的一列：挂载范围下方的图序号都更大。
  expect(Math.min(...down)).toBeGreaterThan(Math.max(...mounted));
  expect(down[0]).toBe(Math.min(...down));
  decoded.length = 0;
  scrollTo(2000);
  await act(async () => {});
  const up = decoded.map(idOf);
  mounted = mountedIds().map(Number);
  expect(up.length).toBeGreaterThan(0);
  expect(up.some((id) => mounted.includes(id))).toBe(false);
  expect(Math.max(...up)).toBeLessThan(Math.max(...mounted));
});

it("滚动位置在停手后与卸载时记住（不在每个滚动事件里写本地存储）", async () => {
  const { view, scrollTo } = await setup();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  for (let top = 1000; top <= 3000; top += 50) scrollTo(top);
  expect(setItem.mock.calls.length).toBeLessThan(5);
  view.unmount();
  const saved = JSON.parse(localStorage.getItem('kinshoko.wall.workspace.{"kind":"all"}')!);
  expect(saved.id).toBeTruthy();
  setItem.mockRestore();
});

it("鼠标滚轮：接管原生滚动，下一帧就动，平滑落在一格之后", async () => {
  const { wall, scrollTo } = await setup();
  scrollTo(1000);
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  expect(fireEvent.wheel(wall, { deltaY: 100, deltaMode: 0 })).toBe(false);
  act(() => { vi.advanceTimersByTime(17); });
  expect(wall.scrollTop).toBeGreaterThan(1000);
  expect(wall.scrollTop).toBeLessThan(1100);
  act(() => { vi.advanceTimersByTime(1500); });
  expect(wall.scrollTop).toBe(1100);
});

it("“减少动画”时滚轮走原生", async () => {
  const { wall } = await setup();
  reduced = true;
  expect(fireEvent.wheel(wall, { deltaY: 100, deltaMode: 0 })).toBe(true);
});

it("精确式触控板的小增量走原生", async () => {
  const { wall } = await setup();
  expect(fireEvent.wheel(wall, { deltaY: 3.5, deltaMode: 0 })).toBe(true);
});

it("沿用的卡片元素仍按最新的选择处理拖动与 Ctrl 单击", async () => {
  const onSelectionChange = vi.fn();
  const view = render(<Wall {...props} selected={new Set(["1"])} onSelectionChange={onSelectionChange} />);
  await screen.findAllByRole("img");
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const first = card("1");
  view.rerender(<Wall {...props} selected={new Set(["1", "2"])} onSelectionChange={onSelectionChange} />);
  expect(card("1")).toBe(first);
  const data = new Map<string, string>();
  fireEvent.dragStart(card("1"), { dataTransfer: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
  expect(JSON.parse(data.get(DRAG_IMAGES)!).sort()).toEqual(["1", "2"]);
  fireEvent.click(card("3"), { ctrlKey: true });
  expect([...onSelectionChange.mock.lastCall![0]].sort()).toEqual(["1", "2", "3"]);
});

it("离开查看器（#179）：最后查看的那张（选择跟着换图）滚入可见并获得焦点", async () => {
  const view = render(<Wall {...props} selected={new Set(["0"])} viewerOpen />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  // 查看器里按 → 走到很靠后的一张，选择跟着换。
  view.rerender(<Wall {...props} selected={new Set(["300"])} viewerOpen />);
  view.rerender(<Wall {...props} selected={new Set(["300"])} viewerOpen={false} />);
  const node = document.querySelector<HTMLElement>('.card[data-id="300"]')!;
  expect(document.activeElement).toBe(node);
  const top = parseFloat(node.style.top);
  expect(top).toBeGreaterThanOrEqual(wall.scrollTop);
  expect(top + parseFloat(node.style.height)).toBeLessThanOrEqual(wall.scrollTop + 800);
});

it("离开查看器时那张已在视口里：不滚动，只接回焦点", async () => {
  const view = render(<Wall {...props} selected={new Set(["1"])} viewerOpen />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  view.rerender(<Wall {...props} selected={new Set(["1"])} viewerOpen={false} />);
  expect(wall.scrollTop).toBe(0);
  expect(document.activeElement).toBe(document.querySelector('.card[data-id="1"]'));
});
