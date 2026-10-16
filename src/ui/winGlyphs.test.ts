import { describe, expect, it } from "vitest";
import { glyphGrid, glyphPath, snapGlyph, type GlyphKind } from "./winGlyphs";

const scales = [1, 1.1041666, 1.25, 1.5, 1.75, 2];
const whole = (value: number) => Math.abs(value - Math.round(value)) < 1e-6;

/** Straight segments as [axis, position of the stroke centre]: H keeps y, V keeps x. */
function straightCentres(d: string) {
  const out: ["x" | "y", number][] = [];
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([MHVLAZ])([^MHVLAZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "M" || cmd === "L") y = n[1];
    if (cmd === "A") y = n[6];
    if (cmd === "H") out.push(["y", y]);
    if (cmd === "V") { out.push(["x", n.at(-1)!]); }
  }
  return out;
}

describe.each(scales)("窗口控件图形在 %s 倍缩放下", (dpr) => {
  const grid = glyphGrid(dpr);

  it("线宽是整数个设备像素，四个图形一样粗", () => {
    expect(Number.isInteger(grid.stroke)).toBe(true);
    expect(grid.stroke).toBeGreaterThanOrEqual(1);
    expect(grid.size).toBe(Math.round(10 * dpr));
  });

  it.each<GlyphKind>(["minimize", "maximize", "restore"])("%s 的横竖线两侧边缘都落在像素边界上", (kind) => {
    const centres = straightCentres(glyphPath(kind, grid));
    expect(centres.length).toBeGreaterThan(0);
    for (const [, centre] of centres) {
      expect(whole(centre - grid.stroke / 2)).toBe(true);
      expect(whole(centre + grid.stroke / 2)).toBe(true);
    }
  });

  it("关闭图形左右、上下对称", () => {
    const n = glyphPath("close", grid).match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(n[0] + n[2]).toBe(grid.size);
    expect(n[1] + n[3]).toBe(grid.size);
  });

  it("按钮落在小数设备像素时，图形起点仍对齐到整像素且基本居中", () => {
    const box = { left: 1234.61328125, top: 15, width: 37.99528, height: 25.99528 };
    const at = snapGlyph(box, grid.size, dpr);
    expect(whole((box.left + at.left) * dpr)).toBe(true);
    expect(whole((box.top + at.top) * dpr)).toBe(true);
    const centre = (box.left + at.left) * dpr + grid.size / 2, wanted = (box.left + box.width / 2) * dpr;
    expect(Math.abs(centre - wanted)).toBeLessThanOrEqual(0.5 + 1e-6);
  });
});
