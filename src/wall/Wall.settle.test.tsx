// 侧栏开合（settle）：过渡一开始就按终点宽度重排，卡片按面板过渡的时长、缓动与起点滑过去；
// 进行中容器逐帧变宽不再重排，结束时宽度与终点相符就不再排。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { workspacePage } from "../test/workspacePage";
import { Wall } from "./Wall";
import type { PanelSlide } from "../shell/usePanelSlide";

let width: number;
let observers: (() => void)[];
let motions: { id: string; cancel: ReturnType<typeof vi.fn>; options: KeyframeAnimationOptions; startTime: number | null }[];
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
  HTMLElement.prototype.animate = function (this: HTMLElement, _frames: Keyframe[], options: KeyframeAnimationOptions) {
    const motion = { id: this.dataset.id!, cancel: vi.fn(), onfinish: null, options, startTime: null };
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
    if (cmd !== "plugin:library|workspace_browse") throw new Error(cmd);
    return workspacePage(Array.from({ length: 300 }, (_, i) => ({ id: String(i), width: 100, height: 100 + (i % 7) * 30 })));
  });
});
afterEach(() => {
  cleanup(); clearMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const props = { workspaceScope: { kind: "all" as const }, scope: { kind: "all" as const }, reloadKey: 0, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };

async function setup() {
  const view = render(<Wall {...props} />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  motions = [];
  const slide = (settle: PanelSlide | null) => view.rerender(<Wall {...props} settle={settle} />);
  return { wall, slide };
}

/** 面板宽度过渡的一帧：容器变宽，ResizeObserver 报告一次。 */
const resize = (next: number) => act(() => { width = next; observers.forEach((notify) => notify()); });
const placement = () => [...document.querySelectorAll<HTMLElement>(".wall .card")]
  .map((node) => [node.dataset.id, node.style.left, node.style.top, node.style.width].join(" "));
const collapse: PanelSlide = { by: 256, duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", startTime: 1234 };

it("面板一开始滑就按终点宽度重排，进行中与结束时都不再排", async () => {
  const { slide } = await setup();
  const before = placement();
  slide(collapse);
  const settled = placement();
  expect(settled).not.toEqual(before);
  for (const next of [1040, 1120, 1200, 1256]) resize(next);
  expect(placement()).toEqual(settled);
  slide(null);
  expect(placement()).toEqual(settled);
});

it("卡片的位移动画用面板过渡的时长、缓动与起点", async () => {
  const { slide } = await setup();
  slide(collapse);
  expect(motions.length).toBeGreaterThan(0);
  for (const motion of motions) {
    expect(motion.options).toMatchObject({ duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    expect(motion.startTime).toBe(1234);
  }
  // 之后与面板无关的重排回到平常的节奏。
  slide(null);
  motions = [];
  resize(900);
  expect(motions.length).toBeGreaterThan(0);
  expect(motions.every((motion) => motion.options.duration === 200 && motion.startTime === null)).toBe(true);
});

it("结束时宽度与终点不符，按实际宽度再排一次", async () => {
  const { slide } = await setup();
  slide(collapse);
  const settled = placement();
  resize(1180);
  slide(null);
  expect(placement()).not.toEqual(settled);
});
