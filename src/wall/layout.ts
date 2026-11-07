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
  /** 打开的托盘（#418）：跨满整宽，托盘里的页排在它里面。没有打开时为 null。 */
  tray: Box | null;
};

/**
 * 一张图的尺寸。`inset`：一摞（#418）的封面四周留出的纸边（CSS 像素），盒子按封面比例算，再加上内缩，
 * 纸边因此不出格子。
 */
export type LayoutInput = readonly { w: number; h: number; inset?: number }[];
/** 打开的托盘：`items` 里从 `at` 起的 `count` 张是托盘里的页，按页序排成行；`pad` 是托盘的上下内边距。 */
export type TrayInput = { at: number; count: number; pad: number };
export type LayoutOptions = {
  width: number;
  /** 目标列宽（CSS 像素）。 */
  target: number;
  gap: number;
  pad: number;
  /** 高宽比上限；特别长的图整体缩小到这个高度，不裁切。null 为不限。 */
  capRatio: number | null;
};

export function masonry(items: LayoutInput, o: LayoutOptions, trayInput: TrayInput | null = null): Layout {
  const inner = Math.max(1, o.width - o.pad * 2);
  const columns = Math.max(1, Math.round((inner + o.gap) / (o.target + o.gap)));
  const columnWidth = (inner - o.gap * (columns - 1)) / columns;
  const heights = new Array<number>(columns).fill(o.pad);
  const lanes: number[][] = Array.from({ length: columns }, () => []);
  const boxes: Box[] = new Array(items.length);
  const x = (lane: number) => o.pad + lane * (columnWidth + o.gap);
  const heightOf = (item: LayoutInput[number]) => {
    const inset = item.inset ?? 0;
    const face = columnWidth - inset * 2;
    let h = face * (item.h / item.w);
    if (o.capRatio) h = Math.min(h, face * o.capRatio);
    return Math.max(h, 24) + inset * 2;
  };
  let tray: Box | null = null;
  for (let index = 0; index < items.length; index++) {
    if (trayInput && index === trayInput.at && trayInput.count > 0) {
      // 托盘从最高的一列底下开始；各页按页序从左到右排成行，每行从上一行最高的那页底下开始。
      const top = Math.max(...heights);
      let row = top + trayInput.pad;
      let rowHeight = 0;
      const end = Math.min(items.length, index + trayInput.count);
      for (let page = index; page < end; page++) {
        const lane = (page - index) % columns;
        if (lane === 0 && page > index) { row += rowHeight + o.gap; rowHeight = 0; }
        const h = heightOf(items[page]);
        boxes[page] = { x: x(lane), y: row, w: columnWidth, h };
        lanes[lane].push(page);
        rowHeight = Math.max(rowHeight, h);
      }
      const bottom = row + rowHeight + trayInput.pad;
      tray = { x: 0, y: top, w: o.width, h: bottom - top };
      heights.fill(bottom + o.gap);
      index = end - 1;
      continue;
    }
    // 放进最短的一列；相差不到 0.5 像素时取左边的。
    let lane = 0;
    for (let c = 1; c < columns; c++) if (heights[c] < heights[lane] - 0.5) lane = c;
    const h = heightOf(items[index]);
    boxes[index] = { x: x(lane), y: heights[lane], w: columnWidth, h };
    heights[lane] += h + o.gap;
    lanes[lane].push(index);
  }
  const height = items.length ? Math.max(...heights) - o.gap + o.pad : 0;
  return { columns, columnWidth, height, boxes, lanes, tray };
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

/** 画布坐标 (x, y) 下的图；落在缝隙或边距里时取离得最近的一张（只看附近一屏）。没有图时为 -1。 */
export function cardAt(layout: Layout, x: number, y: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (const i of visible(layout, y - 400, y + 400)) {
    const b = layout.boxes[i];
    const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
    const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  }
  return best;
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

/**
 * 缩放后的滚动位置：第 index 张图的中心回到光标的高度 pointerY（视口坐标），不越出画布（#122）。
 * 只锚纵向：列数随密度变化，图片墙又只纵向滚动，图所在的列由布局决定。
 */
export function zoomScrollTop(layout: Layout, index: number, pointerY: number, viewport: number): number {
  const b = layout.boxes[index];
  return Math.max(0, Math.min(b.y + b.h / 2 - pointerY, layout.height - viewport));
}
