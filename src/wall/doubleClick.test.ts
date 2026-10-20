import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { DEFAULT_DOUBLE_CLICK, doubleClickSettings, isSecondPress, loadDoubleClickSettings, resetDoubleClickSettings } from "./doubleClick";

afterEach(() => { clearMocks(); resetDoubleClickSettings(); vi.restoreAllMocks(); });

const first = { at: 1000, x: 100, y: 100 };

it("第二下在间隔内、判定矩形内：算双击", () => {
  expect(isSecondPress(first, { at: 1499, x: 102, y: 98 }, DEFAULT_DOUBLE_CLICK, 1)).toBe(true);
  expect(isSecondPress(first, { at: 1500, x: 100, y: 100 }, DEFAULT_DOUBLE_CLICK, 1)).toBe(true);
});

it("超过间隔，或移出以第一下为中心的判定矩形：不算", () => {
  expect(isSecondPress(first, { at: 1501, x: 100, y: 100 }, DEFAULT_DOUBLE_CLICK, 1)).toBe(false);
  expect(isSecondPress(first, { at: 1100, x: 103, y: 100 }, DEFAULT_DOUBLE_CLICK, 1)).toBe(false);
  expect(isSecondPress(first, { at: 1100, x: 100, y: 97 }, DEFAULT_DOUBLE_CLICK, 1)).toBe(false);
});

it("判定矩形按物理像素：缩放 150% 时 CSS 坐标移动 1.5 就超过 2 个物理像素", () => {
  expect(isSecondPress(first, { at: 1100, x: 101, y: 100 }, DEFAULT_DOUBLE_CLICK, 1.5)).toBe(true);
  expect(isSecondPress(first, { at: 1100, x: 101.5, y: 100 }, DEFAULT_DOUBLE_CLICK, 1.5)).toBe(false);
});

it("按系统设置判定；读不到时用 500 ms / 4 px", async () => {
  mockIPC((cmd) => { if (cmd === "double_click") return { intervalMs: 300, width: 10, height: 6 }; throw new Error(cmd); });
  expect(doubleClickSettings()).toEqual(DEFAULT_DOUBLE_CLICK);
  await loadDoubleClickSettings();
  expect(doubleClickSettings()).toEqual({ intervalMs: 300, width: 10, height: 6 });
  resetDoubleClickSettings();
  mockIPC((cmd) => { if (cmd === "double_click") return null; throw new Error(cmd); });
  await loadDoubleClickSettings();
  expect(doubleClickSettings()).toEqual({ intervalMs: 500, width: 4, height: 4 });
  resetDoubleClickSettings();
  mockIPC(() => { throw new Error("no backend"); });
  await loadDoubleClickSettings();
  expect(doubleClickSettings()).toEqual(DEFAULT_DOUBLE_CLICK);
});
