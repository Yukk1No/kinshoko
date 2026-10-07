// 钉图的缩放与贴边动画、右键菜单的打开方式（#64）。纯函数与小状态，便于回归测试。
//
// 动画只在窗口里变换内容（CSS transform，跟着显示器刷新），不逐帧改原生窗口（#7 的结论）。
// 应用壳在动画开始时（需要的话）把窗口放大到装得下整个过渡，结束后再改成静止时的矩形。
// 所有矩形都是屏幕物理像素。

import type { Point, Rect } from "./pixels";

/** 缩放动画的时长。滚轮连续几格时从当前位置接着动。 */
export const ZOOM_MS = 140;
/** 贴边收起、滑出与回到原位的时长。 */
export const SLIDE_MS = 200;

export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 钉图内容在屏幕上的位置随时间的变化。换目标时从此刻看到的位置接着动，不跳。 */
export class ContentMotion {
  private from: Rect;
  private to: Rect;
  private start = 0;
  private duration = 0;

  constructor(at: Rect, now: number) {
    this.from = at;
    this.to = at;
    this.start = now;
  }

  retarget(to: Rect, now: number, duration: number) {
    this.from = this.at(now);
    this.to = to;
    this.start = now;
    this.duration = duration;
  }

  at(now: number): Rect {
    if (this.done(now)) return this.to;
    const t = easeOutCubic((now - this.start) / this.duration);
    return {
      x: lerp(this.from.x, this.to.x, t),
      y: lerp(this.from.y, this.to.y, t),
      width: lerp(this.from.width, this.to.width, t),
      height: lerp(this.from.height, this.to.height, t),
    };
  }

  done(now: number): boolean {
    return this.duration <= 0 || now - this.start >= this.duration;
  }

  get target(): Rect {
    return this.to;
  }
}

/**
 * 内容元素的 CSS 变换。元素按终点尺寸画（canvas 后备尺寸 = `target` 的物理像素），左上角对齐窗口；
 * 此刻看到的位置是 `visual`。静止且与窗口重合时为 `none`，保证逐像素显示（DPI 像素规则）。
 */
export function contentTransform(visual: Rect, target: Rect, window: Rect, dpr: number): string {
  const dx = (visual.x - window.x) / dpr;
  const dy = (visual.y - window.y) / dpr;
  const sx = visual.width / target.width;
  const sy = visual.height / target.height;
  const still = sx === 1 && sy === 1;
  if (still && dx === 0 && dy === 0) return "none";
  const move = `translate(${round(dx)}px, ${round(dy)}px)`;
  return still ? move : `${move} scale(${round(sx)}, ${round(sy)})`;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** 按住多久打开右键菜单（笔与触摸），以及按住时允许的抖动（CSS 像素）。 */
export const HOLD_MS = 500;
export const HOLD_SLOP = 4;

/** 按下就打开右键菜单：笔的侧键与触摸的第二键（button 2）。鼠标右键走 contextmenu 事件。 */
export function pressOpensMenu(pointerType: string, button: number): boolean {
  return pointerType !== "mouse" && button === 2;
}

/**
 * 笔或触摸按住不动 [`HOLD_MS`] 打开右键菜单（Windows Ink 关掉长按右键时也能用）；
 * 动出 [`HOLD_SLOP`] 就是拖动。鼠标不用长按。
 */
export function heldForMenu(pointerType: string, start: Point, now: Point, elapsed: number): boolean {
  if (pointerType === "mouse") return false;
  const moved = Math.hypot(now.x - start.x, now.y - start.y);
  return moved <= HOLD_SLOP && elapsed >= HOLD_MS;
}

/** Ctrl+滚轮调透明度：每格 10%，向上更不透明，限制在 10%～100%（与 Snipaste 相同）。 */
export function wheelOpacity(opacity: number, deltaY: number): number {
  const next = Math.round((opacity - Math.sign(deltaY) * 0.1) * 10) / 10;
  return Math.min(1, Math.max(0.1, next));
}
