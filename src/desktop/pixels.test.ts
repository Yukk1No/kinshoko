import { describe, expect, it } from "vitest";
import { dragSelection, editSelection, reachEdges, selectionPart, selectionRect, toDevicePx } from "./pixels";

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

