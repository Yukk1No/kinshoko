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

/**
 * 拖动中的选区。按下后没有移动（例如双击钉住）时保留原来的选区，免得第二次按下把它清掉。
 */
export function dragSelection(previous: Rect | null, start: Point, current: Point): Rect | null {
  if (start.x === current.x && start.y === current.y) return previous;
  return selectionRect(start, current);
}

/** 画钉图的变换：以画布中心为原点，先镜像（flipX/flipY 为 ±1）再顺时针转 angle，按 width×height 画。 */
export interface PinDrawing {
  angle: number;
  flipX: number;
  flipY: number;
  /** 旋转前的目标尺寸（物理像素），与画布尺寸一样取整。 */
  width: number;
  height: number;
}

export function pinDrawing(pin: PinGeometry & { flipH: boolean; flipV: boolean }): PinDrawing {
  const canvas = pinCanvasSize(pin, 1);
  const odd = pin.rotation % 2 === 1;
  return {
    angle: (pin.rotation * Math.PI) / 2,
    flipX: pin.flipH ? -1 : 1,
    flipY: pin.flipV ? -1 : 1,
    width: odd ? canvas.height : canvas.width,
    height: odd ? canvas.width : canvas.height,
  };
}

/** 按下右下角时的缩放与窗口物理像素尺寸。 */
export interface ZoomStart {
  scale: number;
  width: number;
  height: number;
}

/** 拖右下角缩放：左上角不动，按 (dx, dy)（物理像素）里拖得多的方向算新缩放，保持宽高比。 */
export function cornerZoomScale(start: ZoomStart, dx: number, dy: number): number {
  const factor = Math.max((start.width + dx) / start.width, (start.height + dy) / start.height);
  return start.scale * Math.max(factor, 0);
}

/** 滚轮缩放：每格（deltaY 100）×1.12，向上放大。 */
export function wheelZoomScale(scale: number, deltaY: number): number {
  return scale * Math.pow(1.12, -deltaY / 100);
}

/** 指针（CSS 像素，相对钉图左上角）在右下角的缩放区里。区域最大 24 CSS 像素，小钉图按比例缩小。 */
export function inZoomCorner(at: Point, cssWidth: number, cssHeight: number): boolean {
  const zone = Math.min(24, 0.3 * Math.min(cssWidth, cssHeight));
  return at.x >= cssWidth - zone && at.y >= cssHeight - zone;
}
