import { describe, expect, it } from "vitest";
import { DENSITY_MAX, DENSITY_MIN, createNotchCounter, zoomDensity } from "./zoom";

// #102 故事20/21：Ctrl+滚轮每格按 ×1.1 取整到 10，范围 140–420，往上滚变大。
describe("Ctrl+滚轮的密度步进", () => {
  it("每格 ×1.1 取整到 10；往上（正格数）变大，往下变小", () => {
    expect(zoomDensity(240, 1)).toBe(260);
    expect(zoomDensity(260, 1)).toBe(290);
    expect(zoomDensity(240, -1)).toBe(220);
    expect(zoomDensity(240, 2)).toBe(290);
    expect(zoomDensity(240, 0)).toBe(240);
  });

  it("停在 140–420 之间，连续滚到底也不越界、不卡在中途", () => {
    expect(zoomDensity(400, 1)).toBe(DENSITY_MAX);
    expect(zoomDensity(DENSITY_MAX, 5)).toBe(420);
    expect(zoomDensity(150, -1)).toBe(DENSITY_MIN);
    expect(zoomDensity(DENSITY_MIN, -5)).toBe(140);
    expect(zoomDensity(DENSITY_MIN, 20)).toBe(420);
    expect(zoomDensity(DENSITY_MAX, -20)).toBe(140);
  });
});

describe("滚轮格数", () => {
  const wheel = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode });

  it("鼠标一格（不论 100、125 还是 150 像素）只算一格，上滚为正", () => {
    const count = createNotchCounter();
    expect(count(wheel(-100))).toBe(1);
    expect(count(wheel(-150))).toBe(1);
    expect(count(wheel(125))).toBe(-1);
    expect(count(wheel(-3, 1))).toBe(1);
  });

  it("触控板捏合的小增量累积到半格才算一格；换方向时重新累积", () => {
    const count = createNotchCounter();
    expect(count(wheel(-20))).toBe(0);
    expect(count(wheel(-20))).toBe(0);
    expect(count(wheel(-20))).toBe(1);
    expect(count(wheel(-20))).toBe(0);
    expect(count(wheel(30))).toBe(0);
    expect(count(wheel(30))).toBe(-1);
  });
});
