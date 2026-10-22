// 封印／释放动画测试（Wall.seal-fx*.test.tsx）共用的替身与工具。
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { BrowsePage } from "../bindings/BrowsePage";
import { Wall } from "./Wall";

/** 各用例共用、可改写的状态：每个用例开始时重置。 */
export const fx = {
  resolvers: [] as ((page: BrowsePage) => void)[],
  bookReads: 0,
  book: null as unknown as HTMLButtonElement,
  reduce: false,
  mediaListeners: [] as (() => void)[],
};

/** 在调用它的测试文件里装上 jsdom 排版替身、封印书与浏览应答。 */
export function installSealFx() {
  beforeEach(() => {
    fx.resolvers = [];
    fx.bookReads = 0;
    fx.reduce = false;
    fx.mediaListeners = [];
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    // jsdom 不排版：卡片按自己的内联位置给矩形，墙占满视口，封印书在左下角。
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("card")) {
        const s = this.style;
        return new DOMRect(parseFloat(s.left), parseFloat(s.top), parseFloat(s.width), parseFloat(s.height));
      }
      if (this.classList.contains("seal-book")) { fx.bookReads++; return new DOMRect(8, 700, 40, 40); }
      return new DOMRect(0, 0, 1000, 800);
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: fx.reduce && query.includes("reduce"),
      addEventListener: (_: string, f: () => void) => { fx.mediaListeners.push(f); },
      removeEventListener: () => {},
    }));
    fx.book = document.createElement("button");
    fx.book.className = "rail-btn seal-book";
    document.body.appendChild(fx.book);
    mockConvertFileSrc("windows");
    mockIPC((cmd) => {
      if (cmd !== "plugin:library|browse") throw new Error(cmd);
      return new Promise<BrowsePage>((resolve) => { fx.resolvers.push(resolve); });
    });
  });
  afterEach(() => {
    cleanup(); clearMocks(); fx.book.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
}

export const card = (id: string, adult = false) => ({ id, width: 100, height: 100, thumbnail: `L1/${id}/256`, adult });
export const PAGE: BrowsePage = { cards: [card("a", true), card("g")], total: 2, nextCursor: null };
export const base = {
  libraryId: "L1", scope: { kind: "all" as const }, selected: new Set<string>(),
  onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false,
};
export const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
export const answer = async (page = PAGE) => { await settle(); await act(async () => fx.resolvers[fx.resolvers.length - 1](page)); await settle(); };
export const node = (id: string) => document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
export const ghosts = () => document.querySelectorAll(".fx-ghost").length;
export const frames = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

export async function wallWith(safeMode: boolean, page = PAGE) {
  const view = render(<Wall {...base} reloadKey={0} safeMode={safeMode} />);
  await answer(page);
  // 关着安全模式时成人图下一帧才放出：等这一帧过去再接管时间。
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  return view;
}
