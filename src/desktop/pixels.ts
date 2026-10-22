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

/**
 * 钉图四周阴影那一圈的宽度（物理像素，#239），与 Rust 的 `PIN_EDGE`（`kinshoko-core` 的
 * `desktop::motion`）相同：层的窗口区域按它扩出，阴影画在里面，按在上面等于按在钉图边上。
 */
export const PIN_EDGE = 8;

/** 指针（CSS 像素，相对层窗口）在钉图内容或它四周的阴影上。`content`、`window` 为屏幕物理像素。 */
export function onPin(at: Point, content: Rect, window: Rect, dpr: number): boolean {
  const left = (content.x - PIN_EDGE - window.x) / dpr;
  const top = (content.y - PIN_EDGE - window.y) / dpr;
  const right = (content.x + content.width + PIN_EDGE - window.x) / dpr;
  const bottom = (content.y + content.height + PIN_EDGE - window.y) / dpr;
  return at.x >= left && at.y >= top && at.x < right && at.y < bottom;
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

/** 选区的右、下边离显示器边缘这么近（物理像素）时补到边缘。 */
const EDGE_REACH = 2;

/**
 * 选区夹在显示器（冻结屏幕 `screen`）里，右、下边拖到边上时补到边缘。指针最多到最后一个像素，
 * 而选区不含指针所在的那一列／行，所以最后一列、一行原本选不到；框选窗口又让出了最下面一行
 * （#230，ADR 0011），从下往上拖时起点最低只到倒数第二行。
 */
export function reachEdges(rect: Rect, screen: { width: number; height: number }): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  let right = Math.min(screen.width, rect.x + rect.width);
  let bottom = Math.min(screen.height, rect.y + rect.height);
  if (right >= screen.width - EDGE_REACH) right = screen.width;
  if (bottom >= screen.height - EDGE_REACH) bottom = screen.height;
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
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
