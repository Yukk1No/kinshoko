import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Wall } from "./Wall";

let width: number;
let resize: () => void;
beforeEach(() => {
  width = 1121;
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|browse") throw new Error(cmd);
    return { cards: Array.from({ length: 300 }, (_, i) => ({ id: String(i), width: 100, height: 100, thumbnail: `L1/${i}/256` })), total: 300, nextCursor: null };
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

it("1121 → 1369 → 1121 连续重排后同一张图保持偏移，多次自身滚动事件不漂移", async () => {
  render(<Wall libraryId="L1" scope={{ kind: "all" }} reloadKey={0} selected={new Set()}
    onSelectionChange={() => {}} onOpenImage={() => {}} viewerOpen={false} />);
  await screen.findAllByRole("img");
  const wall = document.querySelector<HTMLElement>(".wall")!;
  wall.scrollTop = 2000;
  fireEvent.scroll(wall);
  const card = () => document.querySelector<HTMLElement>('[data-id="28"]')!;
  const offset = () => parseFloat(card().style.top) - wall.scrollTop;
  expect(offset()).toBeCloseTo(-54.25);

  width = 1369;
  act(() => resize());
  expect(offset()).toBeCloseTo(-54.25);
  fireEvent.scroll(wall);
  fireEvent.scroll(wall);
  width = 1121;
  act(() => resize());
  expect(offset()).toBeCloseTo(-54.25);
});

it("侧栏移动期间保留旧列宽，结束后只按最终宽度重排", async () => {
  const props = { libraryId: "L1", scope: { kind: "all" as const }, reloadKey: 0, selected: new Set<string>(),
    onSelectionChange: () => {}, onOpenImage: () => {}, viewerOpen: false };
  const view = render(<Wall {...props} holdReflow={false} />);
  await screen.findAllByRole("img");
  const card = () => document.querySelector<HTMLElement>('[data-id="0"]')!;
  expect(parseFloat(card().style.width)).toBe(268.25);
  view.rerender(<Wall {...props} holdReflow />);
  width = 1369;
  act(() => resize());
  expect(parseFloat(card().style.width)).toBe(268.25);
  view.rerender(<Wall {...props} holdReflow={false} />);
  expect(parseFloat(card().style.width)).toBe(262.6);
});
