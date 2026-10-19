// #27：安全模式切换时图片墙上的封印／释放动画（原型 sealfx）。动画只是表现：遮蔽照旧在切换的那一帧开始，
// 减少动态效果时没有影子，直接到结束状态。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { BrowsePage } from "../bindings/BrowsePage";
import { RELEASE, SEAL } from "../shell/sealfx";
import { Wall } from "./Wall";

let resolvers: ((page: BrowsePage) => void)[];
let book: HTMLButtonElement;
let reduce: boolean;
let mediaListeners: (() => void)[];

beforeEach(() => {
  resolvers = [];
  reduce = false;
  mediaListeners = [];
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  // jsdom 不排版：卡片按自己的内联位置给矩形，墙占满视口，封印书在左下角。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("card")) {
      const s = this.style;
      return new DOMRect(parseFloat(s.left), parseFloat(s.top), parseFloat(s.width), parseFloat(s.height));
    }
    if (this.classList.contains("seal-book")) return new DOMRect(8, 700, 40, 40);
    return new DOMRect(0, 0, 1000, 800);
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
    addEventListener: (_: string, f: () => void) => { mediaListeners.push(f); },
    removeEventListener: () => {},
  }));
  book = document.createElement("button");
  book.className = "rail-btn seal-book";
  document.body.appendChild(book);
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return new Promise<BrowsePage>((resolve) => { resolvers.push(resolve); });
  });
});
afterEach(() => {
  cleanup(); clearMocks(); book.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const card = (id: string, adult = false) => ({ id, width: 100, height: 100, thumbnail: `L1/${id}/256`, adult });
const PAGE: BrowsePage = { cards: [card("a", true), card("g")], total: 2, nextCursor: null };
const base = {
  libraryId: "L1", scope: { kind: "all" as const }, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false,
};
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const answer = async (page = PAGE) => { await settle(); await act(async () => resolvers[resolvers.length - 1](page)); await settle(); };
const node = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
const ghosts = () => document.querySelectorAll(".fx-ghost").length;
const frames = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

async function wallWith(safeMode: boolean) {
  const view = render(<Wall {...base} reloadKey={0} safeMode={safeMode} />);
  await answer();
  // 关着安全模式时成人图下一帧才放出：等这一帧过去再接管时间。
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  return view;
}

describe("封印", () => {
  it("开启的那次提交里卡片就遮蔽，同时生成影子；影子飞进书里后消失", async () => {
    const view = await wallWith(false);
    expect(node("a").dataset.veiled).toBe("false");

    view.rerender(<Wall {...base} reloadKey={0} safeMode />);
    expect(node("a").dataset.veiled).toBe("true");
    expect(ghosts()).toBe(1); // 只有成人图有影子

    await frames(SEAL.flyAt + SEAL.fly + 20);
    expect(ghosts()).toBe(0);
  });

  it("资料库送回卡片后，留下的卡片按原型的节奏补位：影子起飞后 280 ms 开始，620 ms", async () => {
    const view = await wallWith(false);
    const glides: { id: string; timing: KeyframeAnimationOptions }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, _k: Keyframe[], timing: KeyframeAnimationOptions) {
      glides.push({ id: this.dataset.id!, timing });
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={0} safeMode />);
      await frames(100); // 资料库 100 ms 后确认
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      // 资料库按安全模式送回：成人图不在了，留下的 g 补到它的位置。
      await answer({ cards: [card("g")], total: 1, nextCursor: null });
      const g = glides.find((x) => x.id === "g")!;
      expect(g.timing).toMatchObject({ duration: 620, delay: SEAL.flyAt + 20 - 100, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" });
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("资料库确认得晚也按原型的节奏补位：影子起飞后 280 ms 就开始，资料库回来不打断", async () => {
    const view = await wallWith(false);
    const glides: { id: string; timing: KeyframeAnimationOptions; cancelled: boolean }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, _k: Keyframe[], timing: KeyframeAnimationOptions) {
      const glide = { id: this.dataset.id!, timing, cancelled: false };
      glides.push(glide);
      return { cancel() { glide.cancelled = true; }, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      await frames(SEAL.flyAt + 20 + 16);
      // 资料库还没回来：飞走的图不再占位，g 补到它的位置。
      expect(node("a")).toBeNull();
      const g = glides.filter((x) => x.id === "g");
      expect(g).toHaveLength(1);
      expect(g[0].timing).toMatchObject({ duration: 620, easing: "cubic-bezier(0.65, 0, 0.35, 1)" });
      expect(Number(g[0].timing.delay)).toBeLessThanOrEqual(16);
      // 补位途中资料库送回同样的卡片：不取消、不重来。
      await answer({ cards: [card("g")], total: 1, nextCursor: null });
      expect(glides.filter((x) => x.id === "g")).toHaveLength(1);
      expect(g[0].cancelled).toBe(false);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("补位时挪动的卡片都滑过去，包括点下去时还在视口下方、补位后才进视口的", async () => {
    const many: BrowsePage = { cards: [card("a", true), ...Array.from({ length: 60 }, (_, i) => card(`g${i}`))], total: 61, nextCursor: null };
    const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
    await answer(many);
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const place = () => new Map([...document.querySelectorAll<HTMLElement>(".card")].map((n) => [n.dataset.id!, { left: parseFloat(n.style.left), top: parseFloat(n.style.top) }]));
    const before = place();
    const glided = new Set<string>();
    HTMLElement.prototype.animate = function (this: HTMLElement) {
      glided.add(this.dataset.id!);
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      await frames(SEAL.flyAt + 20 + 16);
      const after = place();
      const moved = [...after].filter(([id, p]) => {
        const old = before.get(id);
        return old && (old.left !== p.left || old.top !== p.top);
      }).map(([id]) => id);
      // 有在视口（800）以下起步的卡片也挪了，确认这条测试覆盖到了它们。
      expect(moved.some((id) => before.get(id)!.top > 800)).toBe(true);
      expect(moved.filter((id) => !glided.has(id))).toEqual([]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("减少动态效果时没有影子，直接遮蔽", async () => {
    reduce = true;
    const view = await wallWith(false);
    view.rerender(<Wall {...base} reloadKey={0} safeMode />);
    expect(node("a").dataset.veiled).toBe("true");
    expect(ghosts()).toBe(0);
  });
});

describe("释放", () => {
  it("关闭后送回的成人图先藏着，影子从书里飞到位置、落地后才显示", async () => {
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    // 资料库确认后重新浏览（App 递增 reloadKey）。
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(node("a").classList.contains("is-arriving")).toBe(true);
    expect(node("g").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(1);

    await frames(RELEASE.flyAt + RELEASE.fly + 20);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(0);
  });

  it("减少动态效果时回来的图直接显示，没有影子", async () => {
    reduce = true;
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(node("a").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(0);
  });

  it("飞行中打开系统的减少动态效果：影子立刻落地，卡片显示", async () => {
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(ghosts()).toBe(1);
    reduce = true;
    act(() => mediaListeners.forEach((f) => f()));
    expect(ghosts()).toBe(0);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
  });
});
