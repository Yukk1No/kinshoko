import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { UiScaleContext } from "../shell/uiScale";
import { workspacePage } from "../test/workspacePage";
import { Wall } from "./Wall";

// #173：界面缩放只放大文字、按钮、侧栏；同一图片大小下，卡片在屏幕上的宽度与每行张数不变。
// 界面缩放 s 时，同一块屏幕的 CSS 宽度是原来的 1/s，devicePixelRatio 是系统的 s 倍。
const SCREEN_WIDTH = 1500;
let cssWidth = SCREEN_WIDTH;
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => cssWidth });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");
  mockIPC((cmd) => {
    if (cmd !== "plugin:library|workspace_browse") throw new Error(cmd);
    return workspacePage(Array.from({ length: 40 }, (_, i) => ({ id: String(i), width: 100, height: 100 })));
  });
});
afterEach(() => { cleanup(); clearMocks(); vi.unstubAllGlobals(); });

/** 墙上第一张卡片缩略图地址里的档位（`L1/0/档位`）。 */
const shownTier = () => Number(document.querySelector<HTMLImageElement>(".wall .card img")!.getAttribute("src")!.split("/").at(-1));

async function wallAt(scale: number) {
  cssWidth = SCREEN_WIDTH / scale;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: scale });
  render(<UiScaleContext.Provider value={scale}>
    <Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={new Set()} onSelectionChange={() => {}}
      onOpenImage={() => {}} viewerOpen={false} density={240} />
  </UiScaleContext.Provider>);
  await screen.findAllByRole("img");
  const cards = [...document.querySelectorAll<HTMLElement>(".wall .card")];
  const firstRow = cards.filter((card) => parseFloat(card.style.top) === parseFloat(cards[0].style.top));
  return { perRow: firstRow.length, screenWidth: parseFloat(cards[0].style.width) * scale };
}

it("界面缩放 100% 与 150% 时每行张数相同，卡片的屏幕宽度不变", async () => {
  const normal = await wallAt(1);
  cleanup();
  const zoomed = await wallAt(1.5);

  expect(normal.perRow).toBe(6);
  expect(zoomed.perRow).toBe(normal.perRow);
  expect(zoomed.screenWidth).toBeCloseTo(normal.screenWidth, 3);
});

it("界面缩放 150% 时缩略图按卡片的实际设备像素计算，与 100% 时一样清楚", async () => {
  await wallAt(1.5);
  // 240 的图片大小在屏幕上是 240 个系统像素宽；devicePixelRatio 1.5 下卡片 160 CSS 像素 = 240 设备像素，再取 1.5 倍余量，
  // 即 360 像素，取到 384 档。
  expect(shownTier()).toBe(384);
});

it("WebView 的设备像素比晚于界面缩放档位到达时，缩略图在它到达后按新值换档", async () => {
  cssWidth = SCREEN_WIDTH / 1.5;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  render(<UiScaleContext.Provider value={1.5}>
    <Wall workspaceScope={{ kind: "all" }} scope={{ kind: "all" }} reloadKey={0} selected={new Set()} onSelectionChange={() => {}}
      onOpenImage={() => {}} viewerOpen={false} density={240} />
  </UiScaleContext.Provider>);
  await screen.findAllByRole("img");
  expect(shownTier()).toBe(256);

  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  await act(async () => { window.dispatchEvent(new Event("resize")); });

  await waitFor(() => expect(shownTier()).toBe(384));
});
