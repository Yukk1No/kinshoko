// #162：详情面板开合（以及 #157 拖动）时图片墙的宽度逐帧变化。宽度稳定前不重排，稳定后只重排一次，
// 起一组位移动画，视口顶部的图不跳走；减少动态效果时直接到最终布局。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Wall } from "./Wall";

let width: number;
let observers: (() => void)[];
let motions: { id: string; cancel: ReturnType<typeof vi.fn> }[];
let reduce: boolean;

beforeEach(() => {
  width = 1000;
  observers = [];
  motions = [];
  reduce = false;
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  // jsdom 不排版：卡片按自己的内联位置（减去墙的滚动）给矩形，墙占满视口。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("card")) {
      const s = this.style, top = this.closest<HTMLElement>(".wall")?.scrollTop ?? 0;
      return new DOMRect(parseFloat(s.left), parseFloat(s.top) - top, parseFloat(s.width), parseFloat(s.height));
    }
    return new DOMRect(0, 0, width, 800);
  });
  HTMLElement.prototype.animate = function (this: HTMLElement) {
    const motion = { id: this.dataset.id!, cancel: vi.fn(), onfinish: null };
    motions.push(motion);
    return motion as unknown as Animation;
  };
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: () => void) {}
    observe() { observers.push(() => this.callback()); }
    disconnect() {}
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return { cards: Array.from({ length: 300 }, (_, i) => ({ id: String(i), width: 100, height: 100 + (i % 7) * 30, thumbnail: `L1/${i}/256` })), total: 300, nextCursor: null };
  });
});
afterEach(() => {
  cleanup(); clearMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const props = { libraryId: "L1", scope: { kind: "all" as const }, reloadKey: 0, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };

async function setup() {
  const view = render(<Wall {...props} />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  motions = [];
  const hold = (holdReflow: boolean) => view.rerender(<Wall {...props} holdReflow={holdReflow} />);
  return { wall, hold };
}

/** 面板宽度过渡的一帧：容器变窄，ResizeObserver 报告一次。 */
const resize = (next: number) => act(() => { width = next; observers.forEach((notify) => notify()); });
const placement = () => [...document.querySelectorAll<HTMLElement>(".wall .card")]
  .map((node) => [node.dataset.id, node.style.left, node.style.top, node.style.width].join(" "));

it("宽度未稳定时连续变化不重排，稳定后只重排一次", async () => {
  const { hold } = await setup();
  const before = placement();
  hold(true);
  for (const next of [980, 940, 870, 790, 720, 680]) resize(next);
  expect(placement()).toEqual(before);
  hold(false);
  const after = placement();
  expect(after).not.toEqual(before);
  // 稳定之后再报告同一宽度，不再重排。
  resize(680);
  expect(placement()).toEqual(after);
});

it("一次开合只起一组位移动画，没有被打断后重来的动画", async () => {
  const { hold } = await setup();
  hold(true);
  for (const next of [960, 880, 760, 680]) resize(next);
  expect(motions).toEqual([]);
  hold(false);
  const ids = motions.map((motion) => motion.id);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  // 稳定后的那次报告不再重排，已起的动画也不被取消。
  resize(680);
  expect(motions.length).toBe(ids.length);
  expect(motions.every((motion) => motion.cancel.mock.calls.length === 0)).toBe(true);
});

it("重排前后视口顶部的那张图不跳走", async () => {
  const { wall, hold } = await setup();
  const box = (node: HTMLElement) => ({ top: parseFloat(node.style.top), bottom: parseFloat(node.style.top) + parseFloat(node.style.height) });
  const top = [...document.querySelectorAll<HTMLElement>(".wall .card")]
    .filter((node) => box(node).bottom > wall.scrollTop)
    .sort((a, b) => box(a).top - box(b).top)[0];
  const offset = box(top).top - wall.scrollTop, cardWidth = top.style.width;
  hold(true);
  for (const next of [900, 760, 680]) resize(next);
  hold(false);
  const moved = document.querySelector<HTMLElement>(`.card[data-id="${top.dataset.id}"]`)!;
  expect(moved.style.width).not.toBe(cardWidth);
  expect(box(moved).top - wall.scrollTop).toBeCloseTo(offset, 0);
});

it("减少动态效果时没有动画，直接到最终布局", async () => {
  reduce = true;
  const { hold } = await setup();
  const before = placement();
  hold(true);
  for (const next of [900, 760, 680]) resize(next);
  hold(false);
  expect(placement()).not.toEqual(before);
  expect(motions).toEqual([]);
});

it("在面板过渡中途重建的图片墙仍按当前宽度先排出来", async () => {
  const normal = render(<Wall {...props} />);
  await screen.findAllByRole("img");
  const expected = placement();
  normal.unmount();
  render(<Wall {...props} holdReflow />);
  await screen.findAllByRole("img");
  expect(placement()).toEqual(expected);
});
