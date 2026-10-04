// Masonry geometry as a pure function of image sizes and width.
// Sizes come from the library record, so nothing is measured from the DOM: the same input
// always gives the same columns, which is what makes "return to the same picture" exact.

export type Box = { x: number; y: number; w: number; h: number };
export type Layout = {
  columns: number;
  columnWidth: number;
  height: number;
  boxes: Box[];
  /** Item indexes per column, in increasing y. */
  lanes: number[][];
};

export type LayoutInput = { w: number; h: number }[];
/** extra: a fixed row under every image, such as a title line. */
export type LayoutOptions = { width: number; target: number; gap: number; pad: number; capRatio: number | null; extra?: number; square?: boolean };

export function masonry(items: LayoutInput, o: LayoutOptions): Layout {
  const inner = Math.max(1, o.width - o.pad * 2);
  const columns = Math.max(1, Math.round((inner + o.gap) / (o.target + o.gap)));
  const columnWidth = (inner - o.gap * (columns - 1)) / columns;
  const heights = new Array<number>(columns).fill(o.pad);
  const lanes: number[][] = Array.from({ length: columns }, () => []);
  const boxes: Box[] = new Array(items.length);
  items.forEach((item, index) => {
    let lane = 0;
    if (o.square) lane = index % columns;
    else for (let c = 1; c < columns; c++) if (heights[c] < heights[lane] - 0.5) lane = c;
    // square: the equal-size grid kept only as a space comparison (#13); pictures letterbox inside.
    let h = o.square ? columnWidth : columnWidth * (item.h / item.w);
    // Very tall images are limited in height and scaled down whole: no cropping (完整构图).
    if (o.capRatio) h = Math.min(h, columnWidth * o.capRatio);
    h = Math.max(h, 24) + (o.extra ?? 0);
    boxes[index] = { x: o.pad + lane * (columnWidth + o.gap), y: heights[lane], w: columnWidth, h };
    heights[lane] += h + o.gap;
    lanes[lane].push(index);
  });
  return { columns, columnWidth, height: Math.max(...heights) - o.gap + o.pad, boxes, lanes };
}

/** Indexes whose box intersects [top, bottom), found per lane by binary search. */
export function visible(layout: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (const lane of layout.lanes) {
    let lo = 0, hi = lane.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = layout.boxes[lane[mid]];
      if (b.y + b.h < top) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < lane.length; i++) {
      const b = layout.boxes[lane[i]];
      if (b.y >= bottom) break;
      out.push(lane[i]);
    }
  }
  return out.sort((a, b) => a - b);
}

/** An anchor ties the scroll position to a picture, not a pixel offset. */
export type Anchor = { id: string; delta: number };

export function captureAnchor(layout: Layout, ids: string[], scrollTop: number, viewport: number, prefer?: string): Anchor | null {
  if (!ids.length) return null;
  if (prefer) {
    const i = ids.indexOf(prefer);
    const b = i >= 0 ? layout.boxes[i] : null;
    if (b && b.y + b.h > scrollTop && b.y < scrollTop + viewport) return { id: prefer, delta: scrollTop - b.y };
  }
  // The picture nearest the top-left of the viewport: what the eye last rested on.
  let best = -1;
  for (const i of visible(layout, scrollTop, scrollTop + viewport)) {
    const b = layout.boxes[i];
    if (b.y + b.h < scrollTop + 8) continue;
    if (best < 0 || b.y < layout.boxes[best].y - 1 || (Math.abs(b.y - layout.boxes[best].y) <= 1 && b.x < layout.boxes[best].x)) best = i;
  }
  if (best < 0) return null;
  return { id: ids[best], delta: scrollTop - layout.boxes[best].y };
}

export function resolveAnchor(layout: Layout, ids: string[], anchor: Anchor | null): number | null {
  if (!anchor) return null;
  const i = ids.indexOf(anchor.id);
  if (i < 0) return null;
  return Math.max(0, layout.boxes[i].y + anchor.delta);
}

/** Spatial neighbour for arrow keys: the nearest box in that direction. */
export function neighbour(layout: Layout, from: number, dir: 'up' | 'down' | 'left' | 'right'): number {
  const a = layout.boxes[from];
  if (!a) return from;
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  let best = from, bestScore = Infinity;
  layout.boxes.forEach((b, i) => {
    if (i === from) return;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = bx - ax, dy = by - ay;
    const vertical = dir === 'up' || dir === 'down';
    const ok = dir === 'up' ? dy < -1 && Math.abs(dx) < a.w * 0.6 : dir === 'down' ? dy > 1 && Math.abs(dx) < a.w * 0.6
      : dir === 'left' ? dx < -1 : dx > 1;
    if (!ok) return;
    // Sideways: prefer the box in the next column that spans the current centre line.
    const spans = b.y <= ay && ay <= b.y + b.h;
    const score = vertical ? Math.abs(dy) + Math.abs(dx) * 4 : Math.abs(dx) + (spans ? 0 : 1e4 + Math.abs(dy));
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
