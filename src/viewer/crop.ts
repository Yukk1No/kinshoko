// 查看器里框选局部（#65）。选区按原图像素记：查看器缩放、平移时边界不变，钉成局部钉图后也不变。
// 纯函数，便于测试。

import type { Region } from "../bindings/Region";
import type { ScreenRect } from "../bindings/ScreenRect";

export interface Point {
  x: number;
  y: number;
}

/** 原图此刻在查看器舞台上的位置与尺寸（CSS 像素）。 */
export interface Shown {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 拖动起点与当前点（舞台上的 CSS 像素）围成的选区，换成原图像素：向外取整到整像素，
 * 超出原图的部分截掉。为空（没拖动、完全在图外）时为 null。
 */
export function cropFromDrag(a: Point, b: Point, shown: Shown, natural: Size): Region | null {
  const toImage = (v: number, start: number, css: number, px: number) => ((v - start) / css) * px;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const xs = [a.x, b.x].map((v) => toImage(v, shown.left, shown.width, natural.width));
  const ys = [a.y, b.y].map((v) => toImage(v, shown.top, shown.height, natural.height));
  const left = clamp(Math.floor(Math.min(...xs)), natural.width);
  const right = clamp(Math.ceil(Math.max(...xs)), natural.width);
  const top = clamp(Math.floor(Math.min(...ys)), natural.height);
  const bottom = clamp(Math.ceil(Math.max(...ys)), natural.height);
  if (a.x === b.x || a.y === b.y || right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 选区（原图像素）此刻在舞台上的位置（CSS 像素）。 */
export function cropOnScreen(crop: Region, shown: Shown, natural: Size): CssRect {
  const sx = shown.width / natural.width;
  const sy = shown.height / natural.height;
  return { x: shown.left + crop.x * sx, y: shown.top + crop.y * sy, width: crop.width * sx, height: crop.height * sy };
}

/** 舞台上的矩形换成相对窗口客户区的物理像素（钉图以它为中心出现）。 */
export function toScreenRect(rect: CssRect, stage: { left: number; top: number }, dpr: number): ScreenRect {
  return {
    x: Math.round((stage.left + rect.x) * dpr),
    y: Math.round((stage.top + rect.y) * dpr),
    width: Math.max(1, Math.round(rect.width * dpr)),
    height: Math.max(1, Math.round(rect.height * dpr)),
  };
}
