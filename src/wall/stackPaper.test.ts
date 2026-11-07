import { describe, expect, it } from "vitest";
import { STACK_INSET, stackPaper } from "./stackPaper";

// 一摞的纸张（#418，维护者 2026-11-07 定为「统一朝向」）：封面摆正，下面几层整体朝一边歪、越往下越歪。
describe("一摞的纸张", () => {
  const face = { w: 180, h: 240 };
  const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ w: 100, h: 120 + i * 20 }));
  const keys = Array.from({ length: 60 }, (_, i) => `pixiv:${1000 + i * 37}`);

  it("封面下最多露三层，两页时一层", () => {
    expect(stackPaper("pixiv:1", pages(2), face)).toHaveLength(1);
    expect(stackPaper("pixiv:1", pages(12), face)).toHaveLength(3);
  });

  it("同一个图集键每次摆得一样", () => {
    expect(stackPaper("pixiv:42", pages(5), face)).toEqual(stackPaper("pixiv:42", pages(5), face));
  });

  it("下面几层与封面同宽，高度按各页自己的比例", () => {
    const [deepest, , top] = stackPaper("pixiv:7", [{ w: 100, h: 100 }, { w: 100, h: 120 }, { w: 100, h: 130 }, { w: 100, h: 125 }], face);
    expect([top.w, deepest.w]).toEqual([180, 180]);
    // 第 1 页 180×216，第 3 页 180×225；超过封面的部分最多多出 2 像素（纸角不出格子）。
    expect(top.h).toBe(216);
    expect(deepest.h).toBe(225);
    const [short] = stackPaper("pixiv:7", [{ w: 100, h: 100 }, { w: 100, h: 60 }], face);
    expect(short.h).toBeCloseTo(240 * 0.84, 6);
    const [tall] = stackPaper("pixiv:7", [{ w: 100, h: 100 }, { w: 100, h: 400 }], face);
    expect(tall.h).toBe(242);
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

  it("静止时纸边露出约 3 到 7 像素、纸角不出格子；拿起后露得更多", () => {
    for (const key of keys) {
      for (const layer of stackPaper(key, pages(4), face)) {
        const half = Math.hypot(layer.w, layer.h) / 2;
        const edge = (r: number) => half * Math.abs(r) * Math.PI / 180;
        expect(edge(layer.rest.r)).toBeGreaterThan(2);
        expect(edge(layer.rest.r)).toBeLessThan(8);
        expect(edge(layer.hot.r)).toBeGreaterThan(edge(layer.rest.r));
        // 转过之后四个角都在格子里：格子是封面加四周的内缩。
        const cx = STACK_INSET + layer.w / 2 + layer.rest.x, cy = STACK_INSET + layer.h / 2 + layer.rest.y;
        const a = layer.rest.r * Math.PI / 180;
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = cx + (dx * layer.w / 2) * Math.cos(a) - (dy * layer.h / 2) * Math.sin(a);
          const py = cy + (dx * layer.w / 2) * Math.sin(a) + (dy * layer.h / 2) * Math.cos(a);
          expect(px).toBeGreaterThanOrEqual(0);
          expect(px).toBeLessThanOrEqual(face.w + STACK_INSET * 2);
          expect(py).toBeGreaterThanOrEqual(0);
          expect(py).toBeLessThanOrEqual(face.h + STACK_INSET * 2);
        }
      }
    }
  });
});
