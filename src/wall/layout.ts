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
  /** 打开的托盘（#418）：跨满墙的内宽，托盘里的页排在它里面。没有打开时为 null。 */
  tray: Box | null;
};

/**
 * 一张图的尺寸。`inset`：一摞（#418）的封面四周留出的纸边，按列宽算（纸边随格子变宽）；盒子按封面比例算，
 * 再加上内缩，纸边因此不出格子。
 */
export type LayoutInput = readonly { w: number; h: number; inset?: (columnWidth: number) => number }[];
/** 打开的托盘：`items` 里从 `at` 起的 `count` 张是托盘里的页，按页序排成齐行；`pad` 是托盘的内边距。 */
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
    const inset = item.inset?.(columnWidth) ?? 0;
    const face = columnWidth - inset * 2;
    let h = face * (item.h / item.w);
    if (o.capRatio) h = Math.min(h, face * o.capRatio);
    return Math.max(h, 24) + inset * 2;
  };
  let tray: Box | null = null;
  for (let index = 0; index < items.length; index++) {
    if (trayInput && index === trayInput.at && trayInput.count > 0) {
      const end = Math.min(items.length, index + trayInput.count);
      const top = Math.max(...heights);
      const bottom = trayRows(items, index, end, top, columnWidth, o, trayInput.pad, boxes);
      for (let page = index; page < end; page++) {
        const center = boxes[page].x + boxes[page].w / 2 - o.pad;
        lanes[Math.min(columns - 1, Math.max(0, Math.floor(center / (columnWidth + o.gap))))].push(page);
      }
      tray = { x: o.pad, y: top, w: inner, h: bottom - top };
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

/**
 * 托盘里的各页（第 5 版原型的齐行排法）：托盘从 `top` 开始，左右缩在墙的边距里；各页按页序从左到右排，
 * 行高以列宽为准，一行排不下时整行等比缩小到刚好排满，最后一行不撑满。返回托盘的底边。
 */
function trayRows(
  items: LayoutInput,
  from: number,
  end: number,
  top: number,
  rowHeight: number,
  o: LayoutOptions,
  pad: number,
  boxes: Box[],
) {
  const left = o.pad + pad;
  const room = Math.max(1, o.width - left * 2);
  const ratio = (item: LayoutInput[number]) => Math.min(item.h / item.w, o.capRatio ?? Infinity);
  let y = top + pad;
  let row: number[] = [];
  const flush = (fit: boolean) => {
    const natural = row.reduce((sum, page) => sum + rowHeight / ratio(items[page]), 0);
    const h = fit ? (rowHeight * (room - o.gap * (row.length - 1))) / natural : rowHeight;
    let x = left;
    for (const page of row) {
      const w = h / ratio(items[page]);
      boxes[page] = { x, y, w, h };
      x += w + o.gap;
    }
    y += h + o.gap;
    row = [];
  };
  for (let page = from; page < end; page++) {
    row.push(page);
    const natural = row.reduce((sum, p) => sum + rowHeight / ratio(items[p]), 0) + o.gap * (row.length - 1);
    if (natural >= room) flush(true);
  }
  if (row.length) flush(false);
  return y - o.gap + pad;
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
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
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

export function resolveAnchor(layout: Layout, ids: readonly string[], anchor: Anchor | null): number | null {
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

export type Direction = "up" | "down" | "left" | "right";

const EPS = 1e-3;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 - EPS && b0 < a1 - EPS;
const better = (d: number, g: number, c: number, bd: number, bg: number, bc: number) =>
  d < bd - EPS || (Math.abs(d - bd) <= EPS && (g < bg - EPS || (Math.abs(g - bg) <= EPS && c < bc - EPS)));

/**
 * 方向键要移到的图：
 * - 上下：在方向前方且横向与当前图重叠的图里，只看没被更近的横向重叠图挡住的前沿，
 *   优先跨过当前图竖中线（或离竖中线最近）的那张，其次纵向更近、水平中心更近。
 * - 左右：在方向前方的图里，优先纵向与当前图重叠的图，再限定到紧邻的那一列，
 *   优先跨过当前图横中线（或离横中线最近）的那张，其次横向更近、纵向中心更近。
 * 这一边没有图时为 `from`。
 */
export function neighbour(layout: Layout, from: number, dir: Direction): number {
  const a = layout.boxes[from];
  if (!a) return from;
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  if (dir === "up" || dir === "down") {
    const down = dir === "down";
    // 同一 (x, w) 槽位只留离当前图最近的一张（同列其余必然被它挡住），把遮挡检查压到常数级。
    const byX = new Map<number, { w: number; i: number; gap: number }[]>();
    for (let i = 0; i < layout.boxes.length; i++) {
      if (i === from) continue;
      const b = layout.boxes[i];
      if (!overlaps(a.x, a.x + a.w, b.x, b.x + b.w)) continue;
      if (!(down ? b.y >= a.y + a.h - 1 : b.y + b.h <= a.y + 1)) continue;
      const gap = down ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
      const list = byX.get(b.x);
      const slot = list?.find((entry) => entry.w === b.w);
      if (!slot) {
        const entry = { w: b.w, i, gap };
        if (list) list.push(entry);
        else byX.set(b.x, [entry]);
      } else if (gap < slot.gap) {
        slot.i = i;
        slot.gap = gap;
      }
    }
    const pool: number[] = [];
    for (const list of byX.values()) for (const entry of list) pool.push(entry.i);
    let best = from;
    let bestDist = Infinity;
    let bestGap = Infinity;
    let bestCenter = Infinity;
    for (const i of pool) {
      const b = layout.boxes[i];
      const blocked = pool.some((j) => {
        if (j === i) return false;
        const c = layout.boxes[j];
        if (!overlaps(b.x, b.x + b.w, c.x, c.x + c.w)) return false;
        return down ? c.y + c.h <= b.y + 1 : c.y >= b.y + b.h - 1;
      });
      if (blocked) continue;
      const dist = Math.max(b.x - ax, 0, ax - (b.x + b.w));
      const gap = down ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
      const center = Math.abs(b.x + b.w / 2 - ax);
      if (better(dist, gap, center, bestDist, bestGap, bestCenter)) {
        best = i;
        bestDist = dist;
        bestGap = gap;
        bestCenter = center;
      }
    }
    return best;
  }

  const right = dir === "right";
  const allAhead: number[] = [];
  const aligned: number[] = [];
  for (let i = 0; i < layout.boxes.length; i++) {
    if (i === from) continue;
    const b = layout.boxes[i];
    if (!(right ? b.x >= a.x + a.w - 1 : b.x + b.w <= a.x + 1)) continue;
    allAhead.push(i);
    if (overlaps(a.y, a.y + a.h, b.y, b.y + b.h)) aligned.push(i);
  }
  const pool = aligned.length ? aligned : allAhead;
  if (!pool.length) return from;
  // 限定到紧邻的那一列：在最近列远缘之前开始的卡片才算相邻列，防止横中线落入缝隙时跳过整列。
  let stop = right ? Infinity : -Infinity;
  for (const i of pool) {
    const b = layout.boxes[i];
    stop = right ? Math.min(stop, b.x + b.w) : Math.max(stop, b.x);
  }
  let best = from;
  let bestDist = Infinity;
  let bestGap = Infinity;
  let bestCenter = Infinity;
  for (const i of pool) {
    const b = layout.boxes[i];
    if (right ? b.x >= stop - EPS : b.x + b.w <= stop + EPS) continue;
    const dist = Math.max(b.y - ay, 0, ay - (b.y + b.h));
    const gap = right ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
    const center = Math.abs(b.y + b.h / 2 - ay);
    if (better(dist, gap, center, bestDist, bestGap, bestCenter)) {
      best = i;
      bestDist = dist;
      bestGap = gap;
      bestCenter = center;
    }
  }
  return best;
}
