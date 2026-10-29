/**
 * Window-control glyphs drawn on the device-pixel grid (design/ui-system/README.md, 窗口框架).
 *
 * A 10 px glyph with a 1.2 px stroke never lines up with device pixels at 125 %, 150 % or any fractional scale,
 * and the buttons themselves sit at fractional device positions. With crisp-edge rendering each edge then snaps
 * to 1 or 2 px on its own (uneven weights, stair-stepped diagonals); with antialiasing the same lines blur.
 * So the glyph is drawn in device pixels: a whole-pixel stroke with every straight edge on a pixel boundary,
 * and its origin is snapped to a whole device pixel. Diagonals and corners keep their antialiasing.
 */
export type GlyphKind = "minimize" | "maximize" | "restore" | "close";

export type GlyphGrid = {
  /** Glyph box in device pixels. */
  size: number;
  /** Stroke width in whole device pixels. */
  stroke: number;
};

export function glyphGrid(dpr: number): GlyphGrid {
  const scale = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return { size: Math.round(10 * scale), stroke: Math.max(1, Math.round(scale)) };
}

/** SVG path data in device-pixel units (viewBox 0 0 size size). */
export function glyphPath(kind: GlyphKind, { size: n, stroke: s }: GlyphGrid): string {
  const h = s / 2, p = Math.max(1, Math.round(n * 0.05));
  const lo = p + h, hi = n - p - h; // stroke centres whose outer edges land on p and n - p
  if (kind === "minimize") {
    const y = Math.floor((n - s) / 2) + h;
    return `M${p} ${y}H${n - p}`;
  }
  if (kind === "maximize") return box(lo, lo, hi, hi, Math.max(h, Math.round(n * 0.16)));
  if (kind === "restore") {
    const a = Math.round(n * 0.2), r = Math.max(h, Math.round(n * 0.12));
    const front = box(lo, lo + a, hi - a, hi, r);
    // The back square shows only above and right of the front one.
    const back = `M${lo + a} ${lo + a}V${lo + r}A${r} ${r} 0 0 1 ${lo + a + r} ${lo}H${hi - r}A${r} ${r} 0 0 1 ${hi} ${lo + r}V${hi - a - r}`
      + `A${r} ${r} 0 0 1 ${hi - r} ${hi - a}H${hi - a}`;
    return front + back;
  }
  const c = Math.round(n * 0.15);
  return `M${c} ${c}L${n - c} ${n - c}M${n - c} ${c}L${c} ${n - c}`;
}

function box(x0: number, y0: number, x1: number, y1: number, r: number) {
  return `M${x0 + r} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}`
    + `H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`;
}

/**
 * Where to put a glyph of `size` device pixels so it is centred in a box (CSS px rect) and starts on a whole
 * device pixel. Returns the offset from the box's top-left corner in CSS px.
 */
export function snapGlyph(box: { left: number; top: number; width: number; height: number }, size: number, dpr: number) {
  const at = (start: number, length: number) => Math.round((start + length / 2) * dpr - size / 2) / dpr - start;
  return { left: at(box.left, box.width), top: at(box.top, box.height) };
}
