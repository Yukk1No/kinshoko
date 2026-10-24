import { describe, expect, it } from "vitest";
import {
  ContentMotion,
  HOLD_MS,
  contentTransform,
  easeOutCubic,
  heldForMenu,
  pressOpensMenu,
  wheelOpacity,
} from "./motion";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

// #64：动画在窗口里变换内容，不逐帧改原生窗口。
describe("ContentMotion", () => {
  it("从起点缓出到终点，结束后停在终点", () => {
    const m = new ContentMotion(rect(0, 0, 100, 50), 0);
    m.retarget(rect(100, 0, 200, 100), 0, 100);
    expect(m.at(0)).toEqual(rect(0, 0, 100, 50));
    const mid = m.at(50);
    expect(mid.x).toBeGreaterThan(50); // 缓出：前半程走得多
    expect(mid.x).toBeLessThan(100);
    expect(m.at(100)).toEqual(rect(100, 0, 200, 100));
    expect(m.at(500)).toEqual(rect(100, 0, 200, 100));
    expect(m.done(99)).toBe(false);
    expect(m.done(100)).toBe(true);
  });

  it("动画中途换目标时从当前看到的位置接着动，不跳", () => {
    const m = new ContentMotion(rect(0, 0, 100, 100), 0);
    m.retarget(rect(100, 0, 100, 100), 0, 100);
    const seen = m.at(40);
    m.retarget(rect(-100, 0, 100, 100), 40, 100);
    expect(m.at(40)).toEqual(seen);
    expect(m.at(140)).toEqual(rect(-100, 0, 100, 100));
  });

  it("不动画时直接到终点", () => {
    const m = new ContentMotion(rect(0, 0, 100, 100), 0);
    m.retarget(rect(30, 40, 10, 10), 5, 0);
    expect(m.at(5)).toEqual(rect(30, 40, 10, 10));
    expect(m.done(5)).toBe(true);
  });
});

describe("easeOutCubic", () => {
  it("两端固定", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});

describe("contentTransform", () => {
  it("静止且与窗口重合时不加变换，保证逐像素显示", () => {
    expect(contentTransform(rect(10, 20, 30, 40), rect(10, 20, 30, 40), rect(10, 20, 30, 40), 1.1)).toBe(
      "none",
    );
  });

  it("按物理像素算偏移与缩放，再换成 CSS 像素", () => {
    // 窗口在 (0, 0)，内容此刻在 (11, 22)、是终点尺寸的一半。
    expect(contentTransform(rect(11, 22, 50, 25), rect(0, 0, 100, 50), rect(0, 0, 400, 400), 1.1)).toBe(
      "translate(10px, 20px) scale(0.5, 0.5)",
    );
  });

  it("收起的钉图停在大窗口里：只有平移", () => {
    expect(contentTransform(rect(-194, 0, 200, 100), rect(-194, 0, 200, 100), rect(-194, 0, 394, 100), 1)).toBe(
      "none",
    );
    expect(contentTransform(rect(0, 0, 200, 100), rect(0, 0, 200, 100), rect(-194, 0, 394, 100), 1)).toBe(
      "translate(194px, 0px)",
    );
  });
});

// 笔与鼠标都能打开右键菜单：鼠标右键走 contextmenu；笔的侧键按下即开；笔或触摸按住不动也开。
describe("右键菜单的打开方式", () => {
  it("笔的侧键（button 2）按下就打开，鼠标右键交给 contextmenu", () => {
    expect(pressOpensMenu("pen", 2)).toBe(true);
    expect(pressOpensMenu("touch", 2)).toBe(true);
    expect(pressOpensMenu("mouse", 2)).toBe(false);
    expect(pressOpensMenu("pen", 0)).toBe(false);
  });

  it("笔按住不动够久就打开，动了就是拖动", () => {
    const at = { x: 10, y: 10 };
    expect(heldForMenu("pen", at, { x: 12, y: 11 }, HOLD_MS)).toBe(true);
    expect(heldForMenu("pen", at, { x: 12, y: 11 }, HOLD_MS - 1)).toBe(false);
    expect(heldForMenu("pen", at, { x: 20, y: 10 }, HOLD_MS)).toBe(false);
    expect(heldForMenu("touch", at, at, HOLD_MS)).toBe(true);
    expect(heldForMenu("mouse", at, at, HOLD_MS * 10)).toBe(false);
  });
});

describe("wheelOpacity", () => {
  it("Ctrl+滚轮每格 10%，限制在 10%～100%", () => {
    expect(wheelOpacity(1, 100)).toBeCloseTo(0.9);
    expect(wheelOpacity(0.5, -100)).toBeCloseTo(0.6);
    expect(wheelOpacity(0.1, 100)).toBeCloseTo(0.1);
    expect(wheelOpacity(1, -100)).toBe(1);
    expect(wheelOpacity(0.15, 100)).toBeCloseTo(0.1);
  });
});
