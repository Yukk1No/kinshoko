import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { createRef } from "react";
import { Wall, type WallHandle } from "./Wall";
import { thumbnailTier } from "./thumbnailTier";

// #102 故事20/21（#111）：Ctrl+滚轮直接驱动密度，锚定光标下的图，停手 220 ms 后提交。
let browsed: number[];
beforeEach(() => {
  browsed = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1121 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    browsed.push((args as { query: { thumbnailPx: number } }).query.thumbnailPx);
    return { cards: Array.from({ length: 300 }, (_, i) => ({ id: String(i), width: 100, height: 100 + (i % 7) * 30, thumbnail: `L1/${i}/256` })), total: 300, nextCursor: null };
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function setup(density = 240) {
  const onDensityPreview = vi.fn();
  const onDensityCommit = vi.fn();
  const ref = createRef<WallHandle>();
  const props = { libraryId: "L1", scope: { kind: "all" as const }, reloadKey: 0, selected: new Set<string>(),
    onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false, onDensityPreview, onDensityCommit };
  const view = render(<Wall ref={ref} {...props} density={density} />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  const rerender = (next: number) => view.rerender(<Wall ref={ref} {...props} density={next} />);
  return { wall, ref, onDensityPreview, onDensityCommit, rerender };
}

const box = (node: HTMLElement) => ({
  left: parseFloat(node.style.left), top: parseFloat(node.style.top),
  width: parseFloat(node.style.width), height: parseFloat(node.style.height),
});
const cards = () => [...document.querySelectorAll<HTMLElement>(".wall .card")];
/** jsdom 的图片墙在视口 (0, 0)：光标的 clientY 加上 scrollTop 即画布坐标。 */
function cardUnder(wall: HTMLElement, x: number, y: number) {
  return cards().find((node) => {
    const b = box(node);
    return x >= b.left && x < b.left + b.width && y + wall.scrollTop >= b.top && y + wall.scrollTop < b.top + b.height;
  })!;
}
const ctrlWheel = (wall: HTMLElement, deltaY: number, x = 600, y = 400) =>
  fireEvent.wheel(wall, { deltaY, deltaMode: 0, ctrlKey: true, clientX: x, clientY: y });

it("Ctrl+滚轮往上一格放大一级（×1.1 取整到 10），往下缩小；阻止 WebView 页面缩放", async () => {
  const { wall, onDensityPreview } = await setup();
  const before = box(cards()[0]).width;
  expect(ctrlWheel(wall, -100)).toBe(false);
  expect(onDensityPreview).toHaveBeenLastCalledWith(260);
  ctrlWheel(wall, -100);
  ctrlWheel(wall, -100);
  expect(onDensityPreview).toHaveBeenLastCalledWith(320);
  expect(box(cards()[0]).width).toBeGreaterThan(before);
  ctrlWheel(wall, 100);
  expect(onDensityPreview).toHaveBeenLastCalledWith(290);
});

it("缩放停在 140–420", async () => {
  const { wall, onDensityPreview } = await setup(400);
  ctrlWheel(wall, -100);
  ctrlWheel(wall, -100);
  expect(onDensityPreview).toHaveBeenLastCalledWith(420);
  for (let i = 0; i < 20; i++) ctrlWheel(wall, 100);
  expect(onDensityPreview).toHaveBeenLastCalledWith(140);
});

it("缩放后光标下的那张图仍在视口里，中心仍在光标的高度", async () => {
  const { wall } = await setup();
  for (const [x, y] of [[600, 400], [150, 120]] as const) {
    const target = cardUnder(wall, x, y).dataset.id!;
    for (let i = 0; i < 3; i++) ctrlWheel(wall, -100, x, y);
    const node = document.querySelector<HTMLElement>(`[data-id="${target}"]`)!;
    const b = box(node);
    expect(b.top + b.height / 2 - wall.scrollTop).toBeCloseTo(y, 0);
    for (let i = 0; i < 4; i++) ctrlWheel(wall, 100, x, y);
    const after = box(document.querySelector<HTMLElement>(`[data-id="${target}"]`)!);
    expect(after.top + after.height / 2 - wall.scrollTop).toBeCloseTo(y, 0);
  }
});

it("滚动中只预览；最后一格后 220 ms 提交一次，提交后位置不动，并按新尺寸重新取缩略图", async () => {
  const { wall, onDensityCommit, rerender } = await setup();
  vi.useFakeTimers();
  ctrlWheel(wall, -100);
  act(() => { vi.advanceTimersByTime(150); });
  ctrlWheel(wall, -100);
  ctrlWheel(wall, -100);
  act(() => { vi.advanceTimersByTime(219); });
  expect(onDensityCommit).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(onDensityCommit).toHaveBeenCalledTimes(1);
  expect(onDensityCommit).toHaveBeenLastCalledWith(320);
  const top = wall.scrollTop;
  const placed = cards().map((node) => [node.dataset.id, node.style.top, node.style.width]);
  const requests = browsed.length;
  vi.useRealTimers();
  await act(async () => { rerender(320); });
  expect(wall.scrollTop).toBe(top);
  expect(cards().map((node) => [node.dataset.id, node.style.top, node.style.width])).toEqual(placed);
  expect(browsed.length).toBeGreaterThan(requests);
  expect(browsed.at(-1)).toBe(Math.ceil(320 * 1.5 * (window.devicePixelRatio || 1)));
});

it("提交的大小与原来同一个缩略图档位时不重新浏览（#200）", async () => {
  const { rerender } = await setup(240);
  const requests = browsed.length;
  const dpr = window.devicePixelRatio || 1;
  expect(thumbnailTier(Math.ceil(250 * 1.5 * dpr))).toBe(thumbnailTier(Math.ceil(240 * 1.5 * dpr)));
  await act(async () => { rerender(250); });
  expect(browsed.length).toBe(requests);
});

it("缩回原来的大小时不提交，只撤掉预览", async () => {
  const { wall, onDensityCommit, onDensityPreview } = await setup();
  vi.useFakeTimers();
  ctrlWheel(wall, -100);
  ctrlWheel(wall, 100);
  act(() => { vi.advanceTimersByTime(220); });
  expect(onDensityCommit).not.toHaveBeenCalled();
  expect(onDensityPreview).toHaveBeenLastCalledWith(null);
});

it("滑条预览仍以视口顶部的图为锚", async () => {
  const { wall, ref } = await setup();
  const topCard = cards().filter((node) => box(node).top + box(node).height >= wall.scrollTop + 8).sort((a, b) => box(a).top - box(b).top || box(a).left - box(b).left)[0];
  const offset = box(topCard).top - wall.scrollTop;
  act(() => ref.current!.previewDensity(320));
  const moved = box(document.querySelector<HTMLElement>(`[data-id="${topCard.dataset.id}"]`)!);
  expect(moved.top - wall.scrollTop).toBeCloseTo(offset);
});

it("没有按 Ctrl 的滚轮不缩放", async () => {
  const { wall, onDensityPreview } = await setup();
  fireEvent.wheel(wall, { deltaY: -100, clientX: 600, clientY: 400 });
  expect(onDensityPreview).not.toHaveBeenCalled();
});
