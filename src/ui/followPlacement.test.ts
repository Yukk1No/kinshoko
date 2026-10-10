import { describe, expect, it } from "vitest";
import { followPlacement } from "./followPlacement";

const bounds = { width: 1000, height: 800 };
const size = { width: 200, height: 52 };

describe("跟随选区的 dock 位置", () => {
  it("放在选区下方 14 px、水平居中", () => {
    expect(followPlacement({ x: 300, y: 100, width: 200, height: 100 }, bounds, size)).toEqual({ left: 300, top: 214 });
  });
  it("下方放不下时翻到选区上方", () => {
    expect(followPlacement({ x: 300, y: 600, width: 200, height: 180 }, bounds, size)).toEqual({ left: 300, top: 534 });
  });
  it("上下都放不下时贴在可用区域底部，并让出底部保留区", () => {
    expect(followPlacement({ x: 300, y: 20, width: 200, height: 760 }, bounds, size, { reserveBottom: 80 })).toEqual({ left: 300, top: 660 });
  });
  it("左右不越出边界", () => {
    expect(followPlacement({ x: -50, y: 100, width: 60, height: 60 }, bounds, size).left).toBe(8);
    expect(followPlacement({ x: 980, y: 100, width: 60, height: 60 }, bounds, size).left).toBe(792);
  });
});
