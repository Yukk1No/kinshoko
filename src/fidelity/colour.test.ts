import { describe, expect, it } from "vitest";
import { deltaE2000, p3ToLab, patchMean } from "./colour";

describe("门槛实验的色彩计算", () => {
  it("ΔE2000 与 Sharma 2005 的发表数据一致", () => {
    const cases: [[number, number, number], [number, number, number], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    ];
    for (const [a, b, expected] of cases) {
      expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
    }
  });

  it("display-p3 的白与黑落在 Lab 的端点，纯红超出 sRGB 红", () => {
    const white = p3ToLab([1, 1, 1]);
    expect(white[0]).toBeCloseTo(100, 1);
    expect(Math.abs(white[1]) + Math.abs(white[2])).toBeLessThan(0.1);
    expect(p3ToLab([0, 0, 0])).toEqual([0, 0, 0]);
    // Display P3 纯红的 Lab（D50）约为 (56.2, 94.5, 97.1)；sRGB 纯红约为 (54.3, 80.8, 69.9)。
    const red = p3ToLab([1, 0, 0]);
    expect(red[0]).toBeCloseTo(56.2, 0);
    expect(red[1]).toBeCloseTo(94.5, 0);
  });

  it("色块平均值按比例换算坐标，只取完整落在区域内的像素", () => {
    // 4×2 的图：左半红、右半蓝，不透明。
    const data = new Uint8ClampedArray(4 * 2 * 4);
    for (let i = 0; i < 8; i++) data.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const right = patchMean({ width: 4, data }, { x: 4, y: 0, width: 4, height: 4 }, 0.5);
    expect(right).toEqual({ rgb: [0, 0, 1], alpha: 1 });
  });
});
