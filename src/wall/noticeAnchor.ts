/**
 * 通知（轻提示与导入任务卡）在窗口里停在哪（#609）：跟着图片墙，不跟着窗口。
 * 右边和右下角那一组对齐（离图片墙右边 inset），底边在图片墙底排浮动件（右下角那一组、多选悬浮栏、
 * 查看器工具条）最高的那一个上面再隔 gap。底排的东西不因通知移动，通知自己让开。
 * 详情栏打开时图片墙右边就是详情栏左边，通知因此不盖详情栏。
 */
export function noticeAnchor({
  host,
  viewport,
  inset,
  rowTop,
  gap = 12,
}: {
  /** 图片墙所在区域在窗口里的位置。 */
  host: { right: number; bottom: number; width: number };
  viewport: { width: number; height: number };
  /** 右下角那一组离图片墙右边的距离。 */
  inset: number;
  /** 底排浮动件里最高的那一个的上沿，离图片墙底边多高。 */
  rowTop: number;
  gap?: number;
}): { right: number; bottom: number; maxWidth: number } {
  return {
    right: Math.round(viewport.width - host.right + inset),
    bottom: Math.round(viewport.height - host.bottom + rowTop + gap),
    maxWidth: Math.max(0, Math.round(host.width - 2 * inset)),
  };
}

/** 一个底排浮动件的上沿离图片墙底边多高：CSS 的 bottom 加自身高度（不量 transform，形变与入场动画不影响结果）。 */
export function rowTopOf(element: HTMLElement, extra = 0): number {
  return (Number.parseFloat(getComputedStyle(element).bottom) || 0) + element.offsetHeight + extra;
}
