/**
 * 查找框里放得下几个条件标签（#222）：`widths` 是各标签的宽度，`room` 是留给标签的宽度。
 * 全放得下就全显示；否则从末尾（最近加的）数起，在前面给“+n”（宽 `more`）留出位置。
 * 返回末尾显示的个数，其余收进“+n”。
 */
export function fitChips(widths: number[], room: number, { gap, more }: { gap: number; more: number }): number {
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(widths.length - 1, 0);
  if (total <= room) return widths.length;
  let used = more;
  let shown = 0;
  for (let i = widths.length - 1; i >= 0; i--) {
    used += gap + widths[i];
    if (used > room) break;
    shown++;
  }
  return shown;
}

/** 输入框至少留这么宽（#222），条件标签再多也不挤占。与样式表里 `.search-field` 的最小宽度一致。 */
const INPUT_MIN = 80;
/** “+n”按钮的宽度上限，量之前先按它留位置。 */
const MORE_WIDTH = 40;

/** 查找框里末尾放得下几个条件标签；还没排版（宽度为 0）时全部显示。 */
export function chipsThatFit(search: HTMLElement | null): number {
  if (!search || search.clientWidth === 0) return Infinity;
  const px = (v: string) => parseFloat(v) || 0;
  const style = getComputedStyle(search);
  const gap = px(style.columnGap);
  const exact = search.querySelector<HTMLElement>(".k-exact")?.offsetWidth ?? 0;
  const room = search.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - exact - INPUT_MIN - gap * 2;
  const list = search.querySelector<HTMLElement>(":scope > .search-chips");
  if (!list) return Infinity;
  const widths = [...list.querySelectorAll<HTMLElement>(":scope > .search-chip")].map((li) => li.offsetWidth);
  return fitChips(widths, room, { gap: px(getComputedStyle(list).columnGap), more: MORE_WIDTH });
}
