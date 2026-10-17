// Ctrl+滚轮缩放（#102 故事20/21，#111）：直接驱动图片大小（密度），与滑条是同一个值。

export const DENSITY_MIN = 140;
export const DENSITY_MAX = 420;
/** 最后一格之后多久提交，与滑条的键盘提交相同。 */
export const ZOOM_COMMIT_MS = 220;

/** 走 notches 格后的密度：每格 ×1.1（负格数 ÷1.1）取整到 10，停在 140–420。正格数变大。 */
export function zoomDensity(value: number, notches: number): number {
  let v = value;
  for (let i = 0; i < Math.abs(notches); i++) {
    const next = notches > 0 ? v * 1.1 : v / 1.1;
    v = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(next / 10) * 10));
  }
  return v;
}

/** 一行折算的像素（deltaMode 1）；一页按一格算。 */
const LINE_PX = 33;
/** 累积到半格（50 像素）算一格。 */
const NOTCH_PX = 50;

/**
 * 把滚轮事件折算成格数，往上（deltaY < 0）为正。鼠标的一格不论系统缩放报 100、125 还是 150 像素都只算一格；
 * 精确式触控板捏合的小增量累积到半格才算一格，换方向时重新累积。
 */
export function createNotchCounter() {
  let acc = 0;
  return (e: { deltaY: number; deltaMode: number }): number => {
    const px = e.deltaMode === 0 ? e.deltaY : e.deltaMode === 1 ? e.deltaY * LINE_PX : Math.sign(e.deltaY) * NOTCH_PX;
    if (px === 0) return 0;
    if (Math.sign(px) !== Math.sign(acc)) acc = 0;
    acc += px;
    if (Math.abs(acc) < NOTCH_PX) return 0;
    const notches = -Math.sign(acc);
    acc = 0;
    return notches;
  };
}
