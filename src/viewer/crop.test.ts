import { describe, expect, it } from "vitest";
import { cropFromDrag, cropOnScreen, toScreenRect } from "./crop";

// 查看器里框选局部（#65）：选区按原图像素记，不随查看器缩放平移改变。

// 800×600 的原图在查看器里显示成 400×300 CSS 像素，左上角在 (100, 50)。
const shown = { left: 100, top: 50, width: 400, height: 300 };
const natural = { width: 800, height: 600 };

describe("拖出的选区换算成原图像素", () => {
  it("按显示比例换算，向外取整到整像素", () => {
    expect(cropFromDrag({ x: 110, y: 60 }, { x: 160.2, y: 110 }, shown, natural)).toEqual({
      x: 20,
      y: 20,
      width: 101,
      height: 100,
    });
  });

  it("反向拖也一样", () => {
    expect(cropFromDrag({ x: 160, y: 110 }, { x: 110, y: 60 }, shown, natural)).toEqual({
      x: 20,
      y: 20,
      width: 100,
      height: 100,
    });
  });

  it("拖出图外的部分截掉", () => {
    expect(cropFromDrag({ x: 0, y: 0 }, { x: 150, y: 100 }, shown, natural)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(cropFromDrag({ x: 450, y: 300 }, { x: 900, y: 900 }, shown, natural)).toEqual({
      x: 700,
      y: 500,
      width: 100,
      height: 100,
    });
  });

  it("没拖动或完全在图外时没有选区", () => {
    expect(cropFromDrag({ x: 120, y: 60 }, { x: 120, y: 60 }, shown, natural)).toBeNull();
    expect(cropFromDrag({ x: 0, y: 0 }, { x: 90, y: 40 }, shown, natural)).toBeNull();
  });

  it("放大时一次拖动可以只框一个原图像素", () => {
    const zoomed = { left: 0, top: 0, width: 8000, height: 6000 };
    expect(cropFromDrag({ x: 31, y: 41 }, { x: 39, y: 49 }, zoomed, natural)).toEqual({
      x: 3,
      y: 4,
      width: 1,
      height: 1,
    });
  });
});

describe("选区画在查看器上", () => {
  it("随查看器的缩放平移换算回 CSS 像素", () => {
    const crop = { x: 20, y: 20, width: 100, height: 100 };
    expect(cropOnScreen(crop, shown, natural)).toEqual({ x: 110, y: 60, width: 50, height: 50 });
    expect(cropOnScreen(crop, { left: -40, top: 0, width: 1600, height: 1200 }, natural)).toEqual({
      x: 0,
      y: 40,
      width: 200,
      height: 200,
    });
  });

  it("换成相对窗口客户区的物理像素", () => {
    expect(toScreenRect({ x: 110, y: 60, width: 50, height: 50 }, { left: 0, top: 40 }, 1.5)).toEqual({
      x: 165,
      y: 150,
      width: 75,
      height: 75,
    });
  });
});
