import { describe, expect, it } from "vitest";
import { approachBand, approachStrip, headingToSubmenu, pointInTriangle, safeTriangle, submenuSide } from "./safeZone";

const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, c = { x: 0, y: 10 };

describe("点在三角形内", () => {
  it("内部的点在内", () => expect(pointInTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true));
  it("外部的点不在内", () => expect(pointInTriangle({ x: 8, y: 8 }, a, b, c)).toBe(false));
  it("边上与顶点上也算在内", () => {
    expect(pointInTriangle({ x: 5, y: 0 }, a, b, c)).toBe(true);
    expect(pointInTriangle(a, a, b, c)).toBe(true);
  });
  it("顶点顺序不影响结果", () => {
    expect(pointInTriangle({ x: 2, y: 2 }, a, c, b)).toBe(true);
    expect(pointInTriangle({ x: 8, y: 8 }, c, b, a)).toBe(false);
  });
});

describe("朝子菜单的那一段宽度", () => {
  it("取父层宽度的 43%，夹在 56 到 90 之间", () => {
    expect(approachBand(100)).toBe(56);
    expect(approachBand(160)).toBeCloseTo(68.8);
    expect(approachBand(260)).toBe(90);
  });
  it("子菜单在右时取父层右侧，在左时取左侧", () => {
    const parent = { left: 0, top: 0, right: 200, bottom: 300 };
    expect(approachStrip(parent, "right")).toEqual({ left: 114, top: 0, right: 200, bottom: 300 });
    expect(approachStrip(parent, "left")).toEqual({ left: 0, top: 0, right: 86, bottom: 300 });
  });
});

describe("安全三角形", () => {
  const sub = { left: 192, top: 40, right: 420, bottom: 240 };
  it("子菜单在右时连到它左边的上下两角", () => {
    expect(safeTriangle({ x: 150, y: 60 }, sub, "right")).toEqual([{ x: 150, y: 60 }, { x: 192, y: 40 }, { x: 192, y: 240 }]);
  });
  it("翻到左边时连到它右边的上下两角", () => {
    expect(safeTriangle({ x: 500, y: 60 }, sub, "left")[1]).toEqual({ x: 420, y: 40 });
  });
  it("看两者中线判断子菜单在哪一侧", () => {
    const parent = { left: 0, top: 0, right: 200, bottom: 300 };
    expect(submenuSide(parent, sub)).toBe("right");
    expect(submenuSide({ left: 300, top: 0, right: 500, bottom: 300 }, sub)).toBe("left");
  });
});

describe("是否正在去子菜单的路上", () => {
  const parent = { left: 0, top: 0, right: 200, bottom: 300 };
  const submenu = { left: 192, top: 40, right: 420, bottom: 240 };
  it("斜着朝子菜单移动、且在父层右侧那一段里，算在路上", () => {
    expect(headingToSubmenu({ apex: { x: 140, y: 60 }, point: { x: 160, y: 80 }, parent, submenu })).toBe(true);
  });
  it("离开三角形（往回走或朝别处）不算", () => {
    expect(headingToSubmenu({ apex: { x: 140, y: 60 }, point: { x: 130, y: 70 }, parent, submenu })).toBe(false);
    expect(headingToSubmenu({ apex: { x: 140, y: 60 }, point: { x: 160, y: 30 }, parent, submenu })).toBe(false);
  });
  it("在父层左侧、离子菜单太远时不算", () => {
    expect(headingToSubmenu({ apex: { x: 20, y: 60 }, point: { x: 60, y: 80 }, parent, submenu })).toBe(false);
  });
  it("子菜单翻到左边时用它的右边", () => {
    const right = { left: 400, top: 0, right: 600, bottom: 300 };
    const left = { left: 180, top: 40, right: 408, bottom: 240 };
    expect(headingToSubmenu({ apex: { x: 460, y: 60 }, point: { x: 440, y: 80 }, parent: right, submenu: left })).toBe(true);
    expect(headingToSubmenu({ apex: { x: 460, y: 60 }, point: { x: 480, y: 80 }, parent: right, submenu: left })).toBe(false);
  });
});
