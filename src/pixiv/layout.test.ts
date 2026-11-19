import { describe, expect, it } from "vitest";
import { pixivMasonry, visibleIn } from "./layout";

const o = { width: 3 * 100 + 2 * 10 + 2 * 20, target: 100, gap: 10, pad: 20, capRatio: null };
const square = (n: number) => Array.from({ length: n }, () => ({ w: 1, h: 1 }));

describe("应用内浏览的瀑布流", () => {
  it("没有展开时和图片墙一样往最短的列里放", () => {
    const layout = pixivMasonry([{ w: 1, h: 2 }, ...square(4)], o);
    expect(layout.columns).toBe(3);
    expect(layout.band).toBeNull();
    // 第 1 张高 200 占第 1 列；后面的方图轮流放进第 2、3 列，再回到最短的列。
    expect(layout.boxes.map((b) => [b.x, b.y])).toEqual([
      [20, 20],
      [130, 20],
      [240, 20],
      [130, 130],
      [240, 130],
    ]);
  });

  it("展开的一格放在点到那张的下沿之下，前面的图位置不变", () => {
    const items = [{ w: 1, h: 2 }, ...square(8)];
    const plain = pixivMasonry(items, o);
    const layout = pixivMasonry(items, o, { at: 1, height: 300 });
    // 点到的第 2 张和它前面的图位置不变。
    expect(layout.boxes.slice(0, 2)).toEqual(plain.boxes.slice(0, 2));
    const band = layout.band;
    expect(band).not.toBeNull();
    if (!band) return;
    const clicked = layout.boxes[1];
    expect(band.y).toBeGreaterThanOrEqual(clicked.y + clicked.h);
    expect(band.x).toBe(20);
    expect(band.w).toBe(320);
    // 展开的一格上下的图互不重叠：要么整张在它上面，要么整张在它下面。
    for (const b of layout.boxes) expect(b.y + b.h <= band.y || b.y >= band.y + band.h).toBe(true);
    expect(layout.boxes.some((b) => b.y >= band.y + band.h)).toBe(true);
    expect(layout.height).toBeGreaterThan(plain.height + 300);
  });

  it("点到最后一张时，展开的一格接在墙的最下面", () => {
    const layout = pixivMasonry(square(3), o, { at: 2, height: 200 });
    expect(layout.band).toEqual({ x: 20, y: 130, w: 320, h: 200 });
    expect(layout.height).toBe(130 + 200 + 20);
  });

  it("按列二分找出可见的图", () => {
    const layout = pixivMasonry(square(30), o);
    const shown = visibleIn(layout, 250, 360);
    expect(shown.length).toBeGreaterThan(0);
    for (const i of shown) {
      const b = layout.boxes[i];
      expect(b.y + b.h >= 250 && b.y < 360).toBe(true);
    }
  });
});
