import { describe, expect, it } from "vitest";
import {
  cornerZoomScale,
  dragSelection,
  inZoomCorner,
  pinCanvasSize,
  pinDrawing,
  selectionRect,
  toDevicePx,
  wheelZoomScale,
} from "./pixels";

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

describe("dragSelection", () => {
  const previous = { x: 10, y: 10, width: 50, height: 30 };

  it("拖动时以起点和当前点重新框选", () => {
    expect(dragSelection(previous, { x: 100, y: 100 }, { x: 90, y: 120 })).toEqual({
      x: 90,
      y: 100,
      width: 10,
      height: 20,
    });
  });

  it("按下没有移动（例如双击钉住）时保留原来的选区", () => {
    expect(dragSelection(previous, { x: 30, y: 20 }, { x: 30, y: 20 })).toBe(previous);
    expect(dragSelection(null, { x: 30, y: 20 }, { x: 30, y: 20 })).toBeNull();
  });
});

// 翻转与旋转（#63 恢复，#64 菜单）：先翻转图片，再绕中心旋转；画的目标尺寸是旋转前的尺寸。
describe("pinDrawing", () => {
  const base = { width: 40, height: 10, scale: 1, rotation: 0, flipH: false, flipV: false };

  it("未翻转旋转时按原尺寸画在原处", () => {
    expect(pinDrawing(base)).toEqual({ angle: 0, flipX: 1, flipY: 1, width: 40, height: 10 });
  });

  it("旋转 90° 时画布宽高互换，图片仍按 40×10 画、转四分之一圈", () => {
    const d = pinDrawing({ ...base, rotation: 1 });
    expect(d.angle).toBeCloseTo(Math.PI / 2, 12);
    expect([d.width, d.height]).toEqual([40, 10]);
    const canvas = pinCanvasSize({ ...base, rotation: 1 }, 1);
    expect([canvas.width, canvas.height]).toEqual([10, 40]);
  });

  it("缩放时目标尺寸与画布一致（取整后的物理像素）", () => {
    const d = pinDrawing({ ...base, width: 101, height: 37, scale: 1.5, rotation: 3 });
    expect([d.width, d.height]).toEqual([152, 56]);
  });

  it("翻转是镜像", () => {
    const d = pinDrawing({ ...base, flipH: true, flipV: true });
    expect([d.flipX, d.flipY]).toEqual([-1, -1]);
  });
});

// 缩放（#63）：笔与鼠标一样拖右下角缩放；滚轮每格 ×1.12。
describe("cornerZoomScale", () => {
  const start = { scale: 1, width: 200, height: 100 };

  it("把右下角拖出一倍宽高时放大一倍", () => {
    expect(cornerZoomScale(start, 200, 100)).toBeCloseTo(2, 12);
  });

  it("按拖得多的那个方向算，保持宽高比", () => {
    expect(cornerZoomScale(start, -100, 0)).toBeCloseTo(1, 12);
    expect(cornerZoomScale(start, -100, -80)).toBeCloseTo(0.5, 12);
  });

  it("从已缩放的状态继续拖", () => {
    expect(cornerZoomScale({ ...start, scale: 0.5 }, 200, 0)).toBeCloseTo(1, 12);
  });
});

describe("wheelZoomScale", () => {
  it("向上滚一格放大 1.12 倍，向下缩小", () => {
    expect(wheelZoomScale(1, -100)).toBeCloseTo(1.12, 12);
    expect(wheelZoomScale(1.12, 100)).toBeCloseTo(1, 12);
  });

  it("精细滚动按比例", () => {
    expect(wheelZoomScale(1, -50)).toBeCloseTo(Math.sqrt(1.12), 12);
  });
});

describe("inZoomCorner", () => {
  it("右下角一小块用来缩放，其余地方拖动", () => {
    expect(inZoomCorner({ x: 195, y: 95 }, 200, 100)).toBe(true);
    expect(inZoomCorner({ x: 100, y: 95 }, 200, 100)).toBe(false);
  });

  it("很小的钉图也留出拖动的地方", () => {
    expect(inZoomCorner({ x: 5, y: 5 }, 20, 20)).toBe(false);
    expect(inZoomCorner({ x: 18, y: 18 }, 20, 20)).toBe(true);
  });
});
