// 应用内浏览（#461）的瀑布流几何：和图片墙同一种排法（`src/wall/layout.ts` 的 `masonry`），
// 另外能在点到的那张图后面原地展开一格（#461 2026-11-18 定的“原型 C”）。纯函数，相同输入得到相同的列。

import type { Box, LayoutOptions } from "../wall/layout";

export type BandInput = {
  /** 点到的那张图的序号。 */
  at: number;
  /** 展开的这一格有多高。 */
  height: number;
};

export type PixivLayout = {
  columns: number;
  columnWidth: number;
  height: number;
  boxes: Box[];
  /** 每一列的图片序号，按 y 递增；`visible` 按它二分查找。 */
  lanes: number[][];
  /** 展开的那一格：横跨整面墙的内宽。没有展开时为 null。 */
  band: Box | null;
};

export type PixivLayoutInput = readonly { w: number; h: number }[];

/**
 * 排一面墙。`band` 不为空时，点到的那张照常排，后面的图也照常往最短的列里补，补到每一列都够到
 * 这张图的下沿为止，然后把展开的一格横着放进去，剩下的图接在它下面。点到的那张和它前面的图位置不变。
 */
export function pixivMasonry(items: PixivLayoutInput, o: LayoutOptions, band: BandInput | null = null): PixivLayout {
  const inner = Math.max(1, o.width - o.pad * 2);
  const columns = Math.max(1, Math.round((inner + o.gap) / (o.target + o.gap)));
  const columnWidth = (inner - o.gap * (columns - 1)) / columns;
  const heights = new Array<number>(columns).fill(o.pad);
  const lanes: number[][] = Array.from({ length: columns }, () => []);
  const boxes: Box[] = new Array(items.length);
  const at = band && band.at >= 0 && band.at < items.length ? band.at : -1;
  let reach: number | null = null;
  let bandBox: Box | null = null;
  const shortest = () => {
    let lane = 0;
    for (let c = 1; c < columns; c++) if (heights[c] < heights[lane] - 0.5) lane = c;
    return lane;
  };
  const placeBand = () => {
    if (!band || bandBox) return;
    const top = Math.max(...heights);
    bandBox = { x: o.pad, y: top, w: inner, h: band.height };
    heights.fill(top + band.height + o.gap);
    reach = null;
  };
  for (let index = 0; index < items.length; index++) {
    const lane = shortest();
    // 每一列都够到点到那张的下沿了：先放展开的一格。
    if (reach !== null && heights[lane] >= reach) placeBand();
    const target = bandBox ? shortest() : lane;
    const item = items[index];
    let h = columnWidth * (item.h / item.w);
    if (o.capRatio) h = Math.min(h, columnWidth * o.capRatio);
    h = Math.max(h, 24);
    boxes[index] = { x: o.pad + target * (columnWidth + o.gap), y: heights[target], w: columnWidth, h };
    heights[target] += h + o.gap;
    lanes[target].push(index);
    if (index === at) reach = boxes[index].y + h;
  }
  if (at >= 0) placeBand();
  const height = items.length ? Math.max(...heights) - o.gap + o.pad : 0;
  return { columns, columnWidth, height, boxes, lanes, band: bandBox };
}

/** 与 [top, bottom) 相交的图片序号：每列二分查找。 */
export function visibleIn(layout: PixivLayout, top: number, bottom: number): number[] {
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
