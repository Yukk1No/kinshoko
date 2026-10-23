import { describe, expect, it } from "vitest";
import {
  cornerZoomScale,
  dragSelection,
  editSelection,
  inZoomCorner,
  onPin,
  PIN_EDGE,
  pinCanvasSize,
  pinDrawing,
  reachEdges,
  selectionPart,
  selectionRect,
  toDevicePx,
  wheelZoomScale,
} from "./pixels";
import rustMotion from "../../crates/kinshoko-core/src/desktop/motion.rs?raw";

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

describe("selectionPart", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("边与角向内外各伸出 reach；内部是 inside，再往外是 outside", () => {
    expect(selectionPart(rect, { x: 200, y: 150 }, 6)).toBe("inside");
    expect(selectionPart(rect, { x: 95, y: 96 }, 6)).toBe("nw");
    expect(selectionPart(rect, { x: 305, y: 204 }, 6)).toBe("se");
    expect(selectionPart(rect, { x: 200, y: 106 }, 6)).toBe("n");
    expect(selectionPart(rect, { x: 294, y: 150 }, 6)).toBe("e");
    expect(selectionPart(rect, { x: 200, y: 207 }, 6)).toBe("outside");
    expect(selectionPart(rect, { x: 50, y: 150 }, 6)).toBe("outside");
  });

  it("选区很窄、两条边都够得着时取更近的那条", () => {
    const thin = { x: 100, y: 100, width: 6, height: 100 };
    expect(selectionPart(thin, { x: 101, y: 150 }, 6)).toBe("w");
    expect(selectionPart(thin, { x: 105, y: 150 }, 6)).toBe("e");
  });
});

describe("editSelection", () => {
  const screen = { width: 1920, height: 1080 };
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("按住内部拖动是平移，大小不变，夹在显示器里", () => {
    expect(editSelection(rect, "inside", 30, -20, screen)).toEqual({ x: 130, y: 80, width: 200, height: 100 });
    expect(editSelection(rect, "inside", -500, 5000, screen)).toEqual({ x: 0, y: 980, width: 200, height: 100 });
  });

  it("按住边只动那条边，按住角动两条边", () => {
    expect(editSelection(rect, "e", 50, 99, screen)).toEqual({ x: 100, y: 100, width: 250, height: 100 });
    expect(editSelection(rect, "n", 99, -40, screen)).toEqual({ x: 100, y: 60, width: 200, height: 140 });
    expect(editSelection(rect, "nw", 20, 10, screen)).toEqual({ x: 120, y: 110, width: 180, height: 90 });
  });

  it("拖过对边时翻过去；拖到显示器右下边时补到边缘", () => {
    expect(editSelection(rect, "w", 260, 0, screen)).toEqual({ x: 300, y: 100, width: 60, height: 100 });
    expect(editSelection(rect, "se", 1619, 879, screen)).toEqual({ x: 100, y: 100, width: 1820, height: 980 });
  });

  it("没有移动时原样返回同一个选区", () => {
    expect(editSelection(rect, "inside", 0, 0, screen)).toBe(rect);
  });
});

// 框选窗口让出显示器最下面一行（#230，ADR 0011），指针按不到那一行；拖到边上时选区补到显示器边缘。
describe("reachEdges", () => {
  const screen = { width: 1920, height: 1080 };

  it("拖到最下面（指针最多到最后一行，或窗口的最后一行）时补上最后一行", () => {
    expect(reachEdges({ x: 100, y: 500, width: 200, height: 579 }, screen)).toEqual({ x: 100, y: 500, width: 200, height: 580 });
    expect(reachEdges({ x: 100, y: 500, width: 200, height: 578 }, screen)).toEqual({ x: 100, y: 500, width: 200, height: 580 });
  });

  it("拖到最右边时补上最后一列（指针最多到 width - 1）", () => {
    expect(reachEdges({ x: 1000, y: 10, width: 919, height: 50 }, screen)).toEqual({ x: 1000, y: 10, width: 920, height: 50 });
  });

  it("拖到下面或右边别的显示器上时夹在这台显示器里", () => {
    expect(reachEdges({ x: 1800, y: 1000, width: 400, height: 300 }, screen)).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
  });

  it("拖到左边或上面别的显示器上时也夹在这台显示器里", () => {
    expect(reachEdges({ x: -50, y: -20, width: 150, height: 120 }, screen)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("离边缘还远时不变", () => {
    const rect = { x: 100, y: 100, width: 300, height: 200 };
    expect(reachEdges(rect, screen)).toEqual(rect);
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

// #239：钉图四周阴影那一圈算钉图的一部分，按下就拖动；再往外点击穿到下面的窗口。
describe("onPin", () => {
  const content = { x: 1100, y: 600, width: 200, height: 100 };
  const window = { x: 1000, y: 500, width: 1920, height: 1079 };

  it("钉图内容和阴影那一圈都算", () => {
    expect(onPin({ x: 150, y: 150 }, content, window, 1)).toBe(true);
    expect(onPin({ x: 100 - PIN_EDGE, y: 100 - PIN_EDGE }, content, window, 1)).toBe(true);
    expect(onPin({ x: 300 + PIN_EDGE - 0.5, y: 200 + PIN_EDGE - 0.5 }, content, window, 1)).toBe(true);
  });

  it("阴影以外不算", () => {
    expect(onPin({ x: 100 - PIN_EDGE - 0.5, y: 150 }, content, window, 1)).toBe(false);
    expect(onPin({ x: 150, y: 200 + PIN_EDGE }, content, window, 1)).toBe(false);
  });

  it("阴影宽度与 Rust 计算窗口区域用的 PIN_EDGE 相同", () => {
    expect(rustMotion.match(/pub const PIN_EDGE: u32 = (\d+);/)?.[1]).toBe(String(PIN_EDGE));
  });

  it("阴影宽度按物理像素：200% 下是一半的 CSS 像素", () => {
    expect(onPin({ x: 50 - PIN_EDGE / 2, y: 75 }, content, window, 2)).toBe(true);
    expect(onPin({ x: 50 - PIN_EDGE / 2 - 0.5, y: 75 }, content, window, 2)).toBe(false);
  });
});
