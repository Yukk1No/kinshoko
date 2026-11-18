import { useLayoutEffect, useRef, type RefObject } from "react";

type Box = { top: number; left: number; right: number; bottom: number };

const SELECTED = '.k-row[aria-current="page"]';

/**
 * 左栏选中的那张小纸片（#608）：在同一个图库的目录里换一行时，纸片从旧的一行滑过来（弹簧约 0.36 秒）。
 * 纸片画在行的 ::before 上，这里只给新的一行的 ::before 补一段从旧位置到原位的动画；
 * 从别的图库或“全部图片”过来的（隔着分界线）不滑，原地浮起。系统设了“减少动态效果”时不滑。
 */
export function usePaperSlide(nav: RefObject<HTMLElement | null>) {
  const last = useRef<{ row: Element; box: Box } | null>(null);
  useLayoutEffect(() => {
    const root = nav.current;
    if (!root) return;
    const row = root.querySelector<HTMLElement>(SELECTED);
    const was = last.current;
    const base = root.getBoundingClientRect();
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top - base.top,
        left: r.left - base.left,
        right: r.right - base.left,
        bottom: r.bottom - base.top,
      };
    };
    const now = row ? box(row) : null;
    last.current = row && now ? { row, box: now } : null;
    if (!row || !now || !was || was.row === row || !was.row.isConnected) return;
    if (typeof row.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    const from = was.box;
    row.animate(
      [
        {
          top: `${from.top - now.top}px`,
          bottom: `${now.bottom - from.bottom}px`,
          left: `${from.left - now.left}px`,
          right: `${now.right - from.right}px`,
        },
        { top: "0px", bottom: "0px", left: "0px", right: "0px" },
      ],
      { duration: 360, easing: "cubic-bezier(0.2, 0.9, 0.25, 1.05)", pseudoElement: "::before" },
    );
  });
}
