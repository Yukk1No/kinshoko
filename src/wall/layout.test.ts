import { describe, expect, it } from "vitest";
import { captureAnchor, masonry, resolveAnchor, visible } from "./layout";

// 瀑布流布局沿用 #13 样稿的纯函数（#9 Q27）：尺寸取自资料库记录，不从 DOM 测量。
describe("瀑布流布局", () => {
  const items = [
    { w: 100, h: 100 },
    { w: 100, h: 300 },
    { w: 200, h: 100 },
    { w: 100, h: 900 },
    { w: 100, h: 100 },
    { w: 100, h: 200 },
  ];
  const opts = { width: 640, target: 200, gap: 8, pad: 12, capRatio: null };

  it("按目标列宽分列，每张放进当前最短的一列", () => {
    // 内宽 616，(616+8)/(200+8)=3 列，列宽 (616-16)/3=200。
    const l = masonry(items, opts);
    expect(l.columns).toBe(3);
    expect(l.columnWidth).toBe(200);
    expect(l.boxes.map((b) => [b.x, b.y, b.h])).toEqual([
      [12, 12, 200],
      [220, 12, 600],
      [428, 12, 100],
      [428, 120, 1800],
      [12, 220, 200],
      [12, 428, 400],
    ]);
    expect(l.height).toBe(12 + 100 + 8 + 1800 + 12);
  });

  it("每张保持原比例、不裁切", () => {
    const l = masonry(items, opts);
    l.boxes.forEach((b, i) => expect(b.h / b.w).toBeCloseTo(items[i].h / items[i].w, 6));
  });

  it("特别长的图整体缩小到上限高度，而不是裁切", () => {
    const l = masonry(items, { ...opts, capRatio: 2.6 });
    expect(l.boxes[3].h).toBeCloseTo(200 * 2.6, 6);
    expect(l.boxes[3].w).toBe(200);
  });

  it("二分查找出的可见范围与逐个比较的结果一致", () => {
    const l = masonry(
      Array.from({ length: 200 }, (_, i) => items[i % items.length]),
      opts,
    );
    const brute = l.boxes.flatMap((b, i) => (b.y + b.h >= 500 && b.y < 900 ? [i] : []));
    expect(visible(l, 500, 900)).toEqual(brute);
  });

  it("宽度变化后，锚定的那张图仍在视口中相同的位置", () => {
    const many = Array.from({ length: 300 }, (_, i) => items[i % items.length]);
    const ids = many.map((_, i) => `p${i}`);
    const wide = masonry(many, { ...opts, width: 1200 });
    const anchor = captureAnchor(wide, ids, 3000, 800)!;
    const narrow = masonry(many, { ...opts, width: 700 });
    const top = resolveAnchor(narrow, ids, anchor)!;
    const i = ids.indexOf(anchor.id);
    expect(top - narrow.boxes[i].y).toBeCloseTo(3000 - wide.boxes[i].y, 6);
  });
});
