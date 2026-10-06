import { describe, expect, it } from "vitest";
import { pinCanvasSize, selectionRect, toDevicePx } from "./pixels";

// DPI 像素规则（#7 两轮回归）：canvas 后备尺寸等于钉图的物理像素，CSS 尺寸 = 物理像素 / dpr，
// 绝不用 100vw 或 innerWidth；否则 110% 下细线变糊、1 px 网格出摩尔纹。
describe("pinCanvasSize", () => {
  it("在 110% 缩放下按物理像素定尺寸，CSS 尺寸是小数", () => {
    const size = pinCanvasSize({ width: 101, height: 37, scale: 1, rotation: 0 }, 1.1);
    expect(size.width).toBe(101);
    expect(size.height).toBe(37);
    expect(size.cssWidth).toBeCloseTo(91.818, 3);
    expect(size.cssHeight).toBeCloseTo(33.636, 3);
    expect(size.pixelated).toBe(true);
  });

  it("150% 下 CSS 尺寸乘回 dpr 正好是物理像素", () => {
    const size = pinCanvasSize({ width: 333, height: 7, scale: 1, rotation: 0 }, 1.5);
    expect(size.cssWidth * 1.5).toBeCloseTo(333, 9);
    expect(size.cssHeight * 1.5).toBeCloseTo(7, 9);
  });

  it("旋转 90° 时宽高互换", () => {
    const size = pinCanvasSize({ width: 40, height: 10, scale: 1, rotation: 1 }, 1);
    expect([size.width, size.height]).toEqual([10, 40]);
  });

  it("缩放后取整，并且不再按像素复制显示", () => {
    const size = pinCanvasSize({ width: 101, height: 37, scale: 0.5, rotation: 0 }, 1);
    expect([size.width, size.height]).toEqual([51, 19]);
    expect(size.pixelated).toBe(false);
  });

  it("再小也至少 1 像素", () => {
    const size = pinCanvasSize({ width: 1, height: 1, scale: 0.05, rotation: 0 }, 1);
    expect([size.width, size.height]).toEqual([1, 1]);
  });
});

// 框选用 pointer 事件的小数坐标：鼠标事件按整 CSS 像素取整，110% 下会差 ±1 物理像素。
describe("toDevicePx", () => {
  it("小数 CSS 坐标换算到准确的物理像素", () => {
    // 110% 下物理像素 101 的左缘在 CSS 91.8181…，整数 CSS 坐标表达不出来。
    expect(toDevicePx(101 / 1.1, 1.1)).toBe(101);
    expect(toDevicePx(92, 1.1)).toBe(101);
    expect(toDevicePx(91, 1.1)).toBe(100);
    expect(toDevicePx(102 / 1.1, 1.1)).toBe(102);
  });
});

describe("selectionRect", () => {
  it("从任意方向拖动都得到左上角和正的宽高", () => {
    expect(selectionRect({ x: 50, y: 40 }, { x: 10, y: 60 })).toEqual({
      x: 10,
      y: 40,
      width: 40,
      height: 20,
    });
  });
});
