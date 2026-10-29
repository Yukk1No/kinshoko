// 截图框选的像素换算（#7 的 DPI 像素规则）。纯函数，便于回归测试。

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

/** 选区的一条边或一个角，按方位命名（n 上、s 下、w 左、e 右），也是对应的 CSS 缩放光标名。 */
export type Grip = "n" | "s" | "w" | "e" | "nw" | "ne" | "sw" | "se";
/** 指针按在选区的哪里：边或角（调整大小）、内部（移动）、外面（重新框选）。 */
export type SelectionPart = Grip | "inside" | "outside";

/** `at` 落在 `low`／`high` 哪条边的 `reach` 以内（两条都近时取更近的），都不近时为空串。 */
function nearEdge(at: number, low: number, high: number, reach: number, [lowName, highName]: [string, string]): string {
  const toLow = Math.abs(at - low);
  const toHigh = Math.abs(at - high);
  if (Math.min(toLow, toHigh) > reach) return "";
  return toLow <= toHigh ? lowName : highName;
}

/** 点 `at` 在选区 `rect` 的哪个部分。边与角向内外各伸出 `reach`，单位与输入相同。 */
export function selectionPart(rect: Rect, at: Point, reach: number): SelectionPart {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (at.x < rect.x - reach || at.x > right + reach || at.y < rect.y - reach || at.y > bottom + reach) return "outside";
  const grip = nearEdge(at.y, rect.y, bottom, reach, ["n", "s"]) + nearEdge(at.x, rect.x, right, reach, ["w", "e"]);
  return (grip || "inside") as SelectionPart;
}

/**
 * 按住选区的一部分拖动 (dx, dy) 后的选区。内部是平移，整个选区夹在显示器（冻结屏幕 `screen`）里；
 * 边或角只动那几条边，拖过对边时翻过去，右、下边照框选一样补到边缘（[`reachEdges`]）。没有移动时原样返回。
 */
export function editSelection(rect: Rect, part: Grip | "inside", dx: number, dy: number, screen: { width: number; height: number }): Rect {
  if (dx === 0 && dy === 0) return rect;
  if (part === "inside") {
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0));
    return { ...rect, x: clamp(rect.x + dx, screen.width - rect.width), y: clamp(rect.y + dy, screen.height - rect.height) };
  }
  const left = rect.x + (part.includes("w") ? dx : 0);
  const top = rect.y + (part.includes("n") ? dy : 0);
  const right = rect.x + rect.width + (part.includes("e") ? dx : 0);
  const bottom = rect.y + rect.height + (part.includes("s") ? dy : 0);
  return reachEdges(selectionRect({ x: left, y: top }, { x: right, y: bottom }), screen);
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
