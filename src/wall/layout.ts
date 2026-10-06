// 瀑布流几何：图片尺寸与宽度的纯函数，沿用 #13 样稿（PR #25/#35）的 layout.ts（#9 Q27）。
// 尺寸取自资料库记录而不是 DOM，相同输入总得到相同的列，“回到同一张图”因此是精确的。

export type Box = { x: number; y: number; w: number; h: number };
export type Layout = {
  columns: number;
  columnWidth: number;
  height: number;
  boxes: Box[];
  /** 每一列的图片序号，按 y 递增。 */
  lanes: number[][];
};

export type LayoutInput = readonly { w: number; h: number }[];
export type LayoutOptions = {
  width: number;
  /** 目标列宽（CSS 像素）。 */
  target: number;
  gap: number;
  pad: number;
  /** 高宽比上限；特别长的图整体缩小到这个高度，不裁切。null 为不限。 */
  capRatio: number | null;
};

export function masonry(items: LayoutInput, o: LayoutOptions): Layout {
  const inner = Math.max(1, o.width - o.pad * 2);
  const columns = Math.max(1, Math.round((inner + o.gap) / (o.target + o.gap)));
  const columnWidth = (inner - o.gap * (columns - 1)) / columns;
  const heights = new Array<number>(columns).fill(o.pad);
  const lanes: number[][] = Array.from({ length: columns }, () => []);
  const boxes: Box[] = new Array(items.length);
  items.forEach((item, index) => {
    // 放进最短的一列；相差不到 0.5 像素时取左边的。
    let lane = 0;
    for (let c = 1; c < columns; c++) if (heights[c] < heights[lane] - 0.5) lane = c;
    let h = columnWidth * (item.h / item.w);
    if (o.capRatio) h = Math.min(h, columnWidth * o.capRatio);
    h = Math.max(h, 24);
    boxes[index] = { x: o.pad + lane * (columnWidth + o.gap), y: heights[lane], w: columnWidth, h };
    heights[lane] += h + o.gap;
    lanes[lane].push(index);
  });
  const height = items.length ? Math.max(...heights) - o.gap + o.pad : 0;
  return { columns, columnWidth, height, boxes, lanes };
}

/** 与 [top, bottom) 相交的图片序号：每列二分查找。 */
export function visible(layout: Layout, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (const lane of layout.lanes) {
    let lo = 0;
    let hi = lane.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const b = layout.boxes[lane[mid]];
      if (b.y + b.h < top) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < lane.length; i++) {
      const b = layout.boxes[lane[i]];
      if (b.y >= bottom) break;
      out.push(lane[i]);
    }
  }
  return out.sort((a, b) => a - b);
}

/** 锚点把滚动位置绑在一张图上，而不是像素偏移。 */
export type Anchor = { id: string; delta: number };

/** 视口左上角最近的那张图及其偏移：眼睛最后停留的地方。 */
export function captureAnchor(
  layout: Layout,
  ids: readonly string[],
  scrollTop: number,
  viewport: number,
): Anchor | null {
  let best = -1;
  for (const i of visible(layout, scrollTop, scrollTop + viewport)) {
    const b = layout.boxes[i];
    if (b.y + b.h < scrollTop + 8) continue;
    const a = best < 0 ? null : layout.boxes[best];
    if (!a || b.y < a.y - 1 || (Math.abs(b.y - a.y) <= 1 && b.x < a.x)) best = i;
  }
  if (best < 0) return null;
  return { id: ids[best], delta: scrollTop - layout.boxes[best].y };
}

export function resolveAnchor(
  layout: Layout,
  ids: readonly string[],
  anchor: Anchor | null,
): number | null {
  if (!anchor) return null;
  const i = ids.indexOf(anchor.id);
  if (i < 0) return null;
  return Math.max(0, layout.boxes[i].y + anchor.delta);
}
