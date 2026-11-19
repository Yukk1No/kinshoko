import { useLayoutEffect, useRef, type RefObject } from "react";

type Box = { top: number; left: number; right: number; bottom: number };

const SELECTED = ':is(.k-row, .lib-head-name)[aria-current="page"]';

/**
 * 左栏选中的那一行左边的强调色短条（#635 甲 指示条）：换一行时，短条从旧的一行滑过来（弹簧约 0.36 秒）。
 * 整个左栏一根短条：“全部图片”、图库行、各图库的文件夹之间都滑；旧的一行已经收起（换图库时）也从它最后的位置滑过来。
 * 短条画在行的 ::after 上（上下各留 8 px），这里只给新的一行的 ::after 补一段从旧位置到原位的动画；选中的底不滑。
 * 系统设了“减少动态效果”时不滑。
 */
export function useIndicatorSlide(nav: RefObject<HTMLElement | null>) {
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
    if (!row || !now || !was || was.row === row) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = was.box;
    const inset = 8;
    row.animate(
      [
        {
          top: `${from.top - now.top + inset}px`,
          bottom: `${now.bottom - from.bottom + inset}px`,
          left: `${from.left - now.left}px`,
        },
        { top: `${inset}px`, bottom: `${inset}px`, left: "0px" },
      ],
      { duration: 360, easing: "cubic-bezier(0.2, 0.9, 0.25, 1.05)", pseudoElement: "::after" },
    );
  });
}
