import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { INSPECTOR_WIDTH } from "./InspectorResizer";

/** 侧栏宽度：平时 256，窗口窄时最窄让到 200。 */
export const SIDEBAR_WIDTH = { initial: 256, min: 200 } as const;
/** 主区（顶栏与图片墙）至少留这么宽；最小窗口 640 − 栏 56 − 详情最窄 280 之后还剩 304。 */
export const MAIN_MIN = 300;

/**
 * 侧栏和详情面板都缩到最窄，主区仍不够 MAIN_MIN：侧栏这时不再并排，收起，点开时浮在图片墙上。
 * `body` 是栏右边的工作区宽度，`inspector` 是详情面板的宽度（关着为 0）。
 */
export function isNarrow(body: number, inspector: number): boolean {
  return body > 0 && body < SIDEBAR_WIDTH.min + (inspector ? INSPECTOR_WIDTH.min : 0) + MAIN_MIN;
}

/**
 * 窄窗口里侧栏与详情面板实际画多宽。主区不够 MAIN_MIN 时，两边按各自还能让出的宽度
 * （侧栏 256 − 200，详情 保存的宽度 − 280）配比一起变窄；侧栏不并排时，详情自己让到 280 为止。
 * 只改画出来的宽度，保存的详情宽度不变，窗口变宽后回到原样。
 */
export function fitPanes(body: number, inspector: number, sidebar: boolean): { sidebar: number; inspector: number } {
  if (body <= 0) return { sidebar: sidebar ? SIDEBAR_WIDTH.initial : 0, inspector };
  if (!sidebar) return { sidebar: 0, inspector: inspector && Math.max(INSPECTOR_WIDTH.min, Math.min(inspector, body - MAIN_MIN)) };
  const short = SIDEBAR_WIDTH.initial + inspector + MAIN_MIN - body;
  if (short <= 0) return { sidebar: SIDEBAR_WIDTH.initial, inspector };
  const sidebarSlack = SIDEBAR_WIDTH.initial - SIDEBAR_WIDTH.min;
  const inspectorSlack = Math.max(inspector - INSPECTOR_WIDTH.min, 0);
  const sidebarCut = Math.min(sidebarSlack, Math.round((short * sidebarSlack) / (sidebarSlack + inspectorSlack)));
  const inspectorCut = Math.min(inspectorSlack, short - sidebarCut);
  return { sidebar: SIDEBAR_WIDTH.initial - sidebarCut, inspector: inspector - inspectorCut };
}

/** 元素的内容宽度，跟着窗口变化；还没挂上时为 0。 */
export function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/**
 * 工作区侧栏在窄窗口里的样子。变窄到并排放不下时侧栏自动收起，变宽后回到收起前的开合；
 * 收起期间点开（顶栏按钮、栏、Ctrl B）就浮在图片墙上。
 */
export function usePaneFold({ body, inspector, paneOpen, onPaneOpen }: {
  body: number;
  /** 详情面板的宽度，关着为 0。 */
  inspector: number;
  paneOpen: boolean;
  onPaneOpen: (open: boolean) => void;
}): { sidebar: number; floating: boolean } {
  const narrow = isNarrow(body, inspector);
  /** 变窄前侧栏开着没有；不窄时为 null。 */
  const before = useRef<boolean | null>(null);
  // 画出来之前就收起，免得侧栏先浮起来闪一下。
  useLayoutEffect(() => {
    if (narrow && before.current === null) {
      before.current = paneOpen;
      if (paneOpen) onPaneOpen(false);
    } else if (!narrow && before.current !== null) {
      if (before.current !== paneOpen) onPaneOpen(before.current);
      before.current = null;
    }
  }, [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  return { sidebar: fitPanes(body, inspector, paneOpen && !narrow).sidebar, floating: paneOpen && narrow };
}

/**
 * 浮起的侧栏按 Esc 收回。点开它的按钮、栏或 Ctrl B 都不把焦点移进侧栏，所以在文档上听；
 * 里面的弹出层已经用掉的 Esc（defaultPrevented）不算。
 */
export function useFloatEscape(floating: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close.current(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floating]);
}
