import { describe, expect, it } from "vitest";
import { stackInset, stackPaper, type Sheet } from "./stackPaper";

/** 一层纸静止时四个角的位置：坐标原点是封面左上角，纸的左上角与封面对齐、绕中心转。 */
function restCorners(sheet: Sheet) {
  const cx = sheet.w / 2 + sheet.rest.x,
    cy = sheet.h / 2 + sheet.rest.y;
  const a = (sheet.rest.r * Math.PI) / 180;
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([dx, dy]) => ({
    x: cx + ((dx * sheet.w) / 2) * Math.cos(a) - ((dy * sheet.h) / 2) * Math.sin(a),
    y: cy + ((dx * sheet.w) / 2) * Math.sin(a) + ((dy * sheet.h) / 2) * Math.cos(a),
  }));
}
/** 纸边露出的长度：转角乘半条对角线。 */
const edge = (sheet: Sheet, r: number) => ((Math.hypot(sheet.w, sheet.h) / 2) * Math.abs(r) * Math.PI) / 180;

// 一摞的纸张（#418，维护者 2026-11-07 定为「统一朝向」）：封面摆正，下面几层整体朝一边歪、越往下越歪。
// 原型的格子封面宽 140 像素，像素数值都以它为准；格子更宽时纸边按比例加宽（维护者 2026-11-08）。
describe("一摞的纸张", () => {
  const face = { w: 140, h: 180 };
  const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ w: 100, h: 120 + i * 20 }));
  const keys = Array.from({ length: 60 }, (_, i) => `pixiv:${1000 + i * 37}`);

  it("封面下最多露三层，两页时一层", () => {
    expect(stackPaper("pixiv:1", pages(2), face)).toHaveLength(1);
    expect(stackPaper("pixiv:1", pages(12), face)).toHaveLength(3);
  });

  it("同一个图集键每次摆得一样", () => {
    expect(stackPaper("pixiv:42", pages(5), face)).toEqual(stackPaper("pixiv:42", pages(5), face));
  });

  it("下面几层与封面同宽，高度按各页自己的比例，最多比封面高出 7 像素（同原型）", () => {
    const [deepest, , top] = stackPaper(
      "pixiv:7",
      [
        { w: 100, h: 100 },
        { w: 100, h: 120 },
        { w: 100, h: 130 },
        { w: 100, h: 125 },
      ],
      face,
    );
    expect([top.w, deepest.w]).toEqual([140, 140]);
    expect(top.h).toBe(168);
    expect(deepest.h).toBe(175);
    const [short] = stackPaper(
      "pixiv:7",
      [
        { w: 100, h: 100 },
        { w: 100, h: 60 },
      ],
      face,
    );
    expect(short.h).toBeCloseTo(180 * 0.84, 6);
    const [tall] = stackPaper(
      "pixiv:7",
      [
        { w: 100, h: 100 },
        { w: 100, h: 400 },
      ],
      face,
    );
    expect(tall.h).toBe(187);
  });

  it("整摞朝一边歪，越往下歪得越多；最多一层反过来，约三分之一的摞有", () => {
    let flippedStacks = 0;
    for (const key of keys) {
      const layers = stackPaper(key, pages(6), face); // 从最下层到最上层
      const signs = layers.map((l) => Math.sign(l.rest.r));
      const main = signs.filter((s) => s === signs[0]).length >= 2 ? signs[0] : -signs[0];
      const flipped = signs.filter((s) => s !== main).length;
      expect(flipped).toBeLessThanOrEqual(1);
      if (flipped) flippedStacks += 1;
      const straight = layers.filter((l) => Math.sign(l.rest.r) === main);
      for (let i = 1; i < straight.length; i++) {
        expect(Math.abs(straight[i - 1].rest.r)).toBeGreaterThan(Math.abs(straight[i].rest.r));
      }
    }
    expect(flippedStacks).toBeGreaterThan(keys.length * 0.15);
    expect(flippedStacks).toBeLessThan(keys.length * 0.55);
  });

  it("封面宽 140 时静止纸边露出约 3 到 7 像素；拿起后露得更多", () => {
    for (const key of keys) {
      for (const layer of stackPaper(key, pages(4), face)) {
        expect(edge(layer, layer.rest.r)).toBeGreaterThan(2);
        expect(edge(layer, layer.rest.r)).toBeLessThan(8);
        expect(edge(layer, layer.hot.r)).toBeGreaterThan(edge(layer, layer.rest.r));
      }
    }
  });

  it("封面更宽时整摞按比例放大，更窄时纸边不再变细", () => {
    const base = stackPaper("pixiv:7", pages(4), face);
    const wide = stackPaper("pixiv:7", pages(4), { w: 280, h: 360 });
    wide.forEach((layer, i) => {
      expect(layer.h).toBeCloseTo(base[i].h * 2, 0);
      expect(layer.rest.r).toBeCloseTo(base[i].rest.r, 1);
      expect(layer.rest.x).toBeCloseTo(base[i].rest.x * 2, 6);
      expect(edge(layer, layer.rest.r)).toBeCloseTo(edge(base[i], base[i].rest.r) * 2, 0);
    });
    const narrow = stackPaper("pixiv:7", pages(4), { w: 105, h: 135 });
    narrow.forEach((layer, i) => {
      expect(layer.rest.x).toBeCloseTo(base[i].rest.x, 6);
      expect(edge(layer, layer.rest.r)).toBeCloseTo(edge(base[i], base[i].rest.r), 0);
    });
  });

  it("像素数值随界面缩放换算：200% 时布局单位里的封面宽 70，摆法与 100% 时的 140 一样", () => {
    const at100 = stackPaper("pixiv:7", pages(4), face);
    const at200 = stackPaper("pixiv:7", pages(4), { w: 70, h: 90 }, 0.5);
    at200.forEach((layer, i) => {
      expect(layer.rest.x).toBeCloseTo(at100[i].rest.x / 2, 6);
      expect(layer.rest.r).toBeCloseTo(at100[i].rest.r, 1);
    });
  });
});

// 一摞在瀑布流里的安全边距：格子按静止时最外扩的那个纸角留出内缩，不按固定值。
describe("一摞的安全边距", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `pixiv:${2000 + i * 53}`);
  const pages = [
    { w: 100, h: 140 },
    { w: 100, h: 150 },
    { w: 100, h: 120 },
    { w: 100, h: 160 },
  ];
  const outermost = (key: string, box: number, inset: number) => {
    const face = { w: box - inset * 2, h: (box - inset * 2) * 1.4 };
    let reach = 0;
    for (const sheet of stackPaper(key, pages, face)) {
      for (const p of restCorners(sheet)) reach = Math.max(reach, -p.x, -p.y, p.x - face.w, p.y - face.h);
    }
    return reach;
  };

  it("静止时每个纸角都在格子里，最外扩的那个角贴着内缩（只多留阴影的 2 像素）", () => {
    for (const key of keys) {
      for (const box of [120, 200, 300, 450]) {
        const inset = stackInset(key, pages, box, 2.6);
        const reach = outermost(key, box, inset);
        expect(reach).toBeLessThanOrEqual(inset - 2 + 1e-6);
        expect(inset - 2 - reach).toBeLessThan(0.05);
      }
    }
  });

  it("格子越宽，纸边越宽，内缩也越大", () => {
    expect(stackInset("pixiv:7", pages, 450, 2.6)).toBeGreaterThan(stackInset("pixiv:7", pages, 300, 2.6) * 1.3);
  });

  it("两页的摞只露一层纸，内缩更小", () => {
    expect(stackInset("pixiv:7", pages.slice(0, 2), 300, 2.6)).toBeLessThan(stackInset("pixiv:7", pages, 300, 2.6));
  });
});
