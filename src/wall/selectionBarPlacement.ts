/**
 * 多选悬浮栏在图片墙里的位置（#180），写法参照 followPlacement：默认水平居中；右边离右下角折叠后的
 * 圆形按钮（左边在 cornerLeft）不到 gap 时整体左移，刚好隔开 gap，但左边至少留 margin；还放不下就
 * 隐藏圆形按钮，悬浮栏回到居中（比悬浮栏还窄时贴左边）。
 */
export function selectionBarPlacement({ wallWidth, barWidth, cornerLeft, gap = 8, margin = 16 }: {
  wallWidth: number; barWidth: number; cornerLeft: number; gap?: number; margin?: number;
}): { left: number; hideCorner: boolean } {
  const centred = (wallWidth - barWidth) / 2;
  const limit = cornerLeft - gap - barWidth;
  if (centred <= limit) return { left: centred, hideCorner: false };
  if (limit >= margin) return { left: limit, hideCorner: false };
  return { left: Math.max(0, centred), hideCorner: true };
}

/**
 * 图片墙窄得连完整的悬浮栏（fullWidth，含“已选 N 张”读数）加两边 margin 都放不下时，改用紧凑的悬浮栏
 * （读数只写“N 张”），不出现水平溢出。fullWidth 还没量到（0）时按完整的算。
 */
export function selectionBarCompact(wallWidth: number, fullWidth: number, margin = 16) {
  return fullWidth > 0 && wallWidth - 2 * margin < fullWidth;
}
