// 桌面钉图与框选的像素换算（#7 的 DPI 像素规则）。纯函数，便于回归测试。

/** 钉图显示用到的几何：图片像素尺寸（未旋转）、缩放（图片像素 → 物理像素）、顺时针四分之一圈数。 */
export interface PinGeometry {
  width: number;
  height: number;
  scale: number;
  rotation: number;
}

export interface CanvasSize {
  /** canvas 后备尺寸，等于钉图窗口的物理像素。 */
  width: number;
  height: number;
  /** CSS 尺寸 = 物理像素 / dpr。不能用 100vw 或 innerWidth（整 CSS 像素，会被重新采样）。 */
  cssWidth: number;
  cssHeight: number;
  /** 未缩放时翻转和 90° 旋转都是像素置换，按像素复制显示，不做平滑。 */
  pixelated: boolean;
}

export function pinCanvasSize(pin: PinGeometry, dpr: number): CanvasSize {
  const odd = pin.rotation % 2 === 1;
  const width = Math.max(1, Math.round((odd ? pin.height : pin.width) * pin.scale));
  const height = Math.max(1, Math.round((odd ? pin.width : pin.height) * pin.scale));
  return {
    width,
    height,
    cssWidth: width / dpr,
    cssHeight: height / dpr,
    pixelated: Math.abs(pin.scale - 1) < 1e-9,
  };
}

/** pointer 事件的小数 CSS 坐标换算成物理像素。鼠标事件只有整 CSS 像素，110% 下会差 ±1。 */
export function toDevicePx(css: number, dpr: number): number {
  return Math.round(css * dpr);
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 拖动起点与当前点围成的选区，单位与输入相同。 */
export function selectionRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}
