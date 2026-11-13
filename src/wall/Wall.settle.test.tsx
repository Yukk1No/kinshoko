// 面板开合（settle，侧栏与详情面板同一条路）：过渡一开始就按终点宽度重排，卡片按面板过渡的时长、缓动与起点滑过去；
// 进行中容器逐帧变宽不再重排，结束时宽度与终点相符就不再排。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { resize as report, setMedia } from "../test/platform";
import { workspacePage } from "../test/workspacePage";
import { Wall } from "./Wall";
import type { PanelSlide } from "../shell/usePanelSlide";

let width: number;
let motions: { id: string; cancel: ReturnType<typeof vi.fn>; options: KeyframeAnimationOptions; startTime: number | null }[];

beforeEach(() => {
  width = 1000;
  motions = [];
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
  const slide = (settle: PanelSlide | null, holdReflow = false) => view.rerender(<Wall {...props} settle={settle} holdReflow={holdReflow} />);
  return { wall, slide };
}

/** 面板宽度过渡的一帧：容器变宽，ResizeObserver 报告一次。 */
const resize = (next: number) => act(() => { width = next; report(document.querySelector(".wall")!); });
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

const expand: PanelSlide = { by: -320, duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", startTime: 1234 };

it("详情面板打开（墙变窄）：一开始就按终点宽度排，进行中与结束时都不再排", async () => {
  const { slide } = await setup();
  const before = placement();
  slide(expand);
  const settled = placement();
  expect(settled).not.toEqual(before);
  const ids = motions.map((motion) => motion.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const next of [960, 880, 760, 680]) resize(next);
  expect(placement()).toEqual(settled);
  slide(null);
  expect(placement()).toEqual(settled);
  // 整个开合只起了开始那一组卡片动画。
  expect(motions.map((motion) => motion.id)).toEqual(ids);
});

it("中途反向：从当前位置按新过渡排回新的终点，只重排这一次，结束不再补排", async () => {
  const { slide } = await setup();
  const before = placement();
  slide(expand);
  const first = [...motions];
  resize(840);
  motions = [];
  // 面板从 160 退回 0：墙现在 840，终点 1000。
  slide({ ...expand, by: 160, duration: 130, startTime: 1300 });
  expect(placement()).toEqual(before);
  expect(first.every((motion) => motion.cancel.mock.calls.length === 1)).toBe(true);
  expect(motions.length).toBeGreaterThan(0);
  expect(motions.every((motion) => motion.options.duration === 130 && motion.startTime === 1300)).toBe(true);
  const back = motions.length;
  for (const next of [900, 960, 1000]) resize(next);
  slide(null);
  expect(placement()).toEqual(before);
  expect(motions.length).toBe(back);
});

it("两个面板一起滑时第二个开始不重复排", async () => {
  const { slide } = await setup();
  slide(expand);
  const settled = placement(), started = motions.length;
  // 同一帧里第二个面板的 transitionrun：算出的终点相同。
  slide({ ...expand });
  expect(placement()).toEqual(settled);
  expect(motions.length).toBe(started);
});

it("拖动面板边缘（holdReflow）期间另一个面板的 slide 不触发重排，松手后等它结束才按实际宽度排一次", async () => {
  const { slide } = await setup();
  const before = placement();
  slide(null, true);
  for (const next of [980, 940, 900]) resize(next);
  // 窄窗口里拖宽详情，侧栏跟着让位产生的过渡。
  slide(expand, true);
  expect(placement()).toEqual(before);
  expect(motions).toEqual([]);
  // 松手时侧栏还在滑：旧的变化量已经不对，不能拿来排。
  slide(expand, false);
  expect(placement()).toEqual(before);
  resize(880);
  expect(placement()).toEqual(before);
  slide(null, false);
  expect(placement()).not.toEqual(before);
});

it("减弱动效：按终点宽度排，没有卡片动画", async () => {
  setMedia("(prefers-reduced-motion: reduce)", true);
  const { slide } = await setup();
  const before = placement();
  slide(expand);
  expect(placement()).not.toEqual(before);
  expect(motions).toEqual([]);
});
