import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** 图片墙旁边的面板正在滑到终点：墙的宽度会变多少，以及这段宽度过渡的节奏。 */
export type PanelSlide = {
  /** 过渡结束时墙比现在宽多少（面板收起为正、展开为负）。 */
  by: number;
  duration: number;
  easing: string;
  /** 面板这段 CSS 过渡的开始时刻（文档时间线）；还没定下时为 null。 */
  startTime: number | null;
};

/** 图片墙旁边的一个面板。`finalWidth` 是它这次开合的终点宽度；浮在墙上、不占墙的宽度时为 null。 */
export type SlidingPanel = { element: HTMLElement | null; finalWidth: number | null };

/**
 * 任一面板的宽度过渡进行中时给出 PanelSlide，全部结束后为 null。过渡一开始就知道终点，
 * 图片墙可以直接按终点宽度排好，让卡片和面板同起同落，不跟着面板平移后再折回来。
 * 窄窗口里侧栏与详情面板会一起让位，所以 `by` 是所有占墙宽的面板的变化量之和，节奏取自刚开始的那个面板；
 * 一个先结束时 slide 不变，免得拿开始时的变化量和已经变了的墙宽重算一遍。
 * 计数、只认自身 width 过渡、在事件里同步提交：过渡中途反向时旧的取消、新的开始，两个事件的先后不定；
 * 浏览器在同一帧里先派发过渡事件、后报告尺寸变化，要赶在尺寸观察之前（#162）。面板的个数不能变。
 */
export function usePanelSlide(panels: readonly SlidingPanel[]): PanelSlide | null {
  const latest = useRef(panels);
  latest.current = panels;
  const [state, setState] = useState<{ running: number; slide: PanelSlide | null }>({ running: 0, slide: null });
  useEffect(() => {
    setState({ running: 0, slide: null });
    const elements = panels.flatMap((panel) => panel.element ?? []);
    const own = (e: Event) => e.target === e.currentTarget && (e as TransitionEvent).propertyName === "width";
    const widthTransition = (element: HTMLElement) => element.getAnimations().find((a) => (a as CSSTransition).transitionProperty === "width");
    const slideOf = (element: HTMLElement): PanelSlide => {
      const transition = widthTransition(element);
      const timing = transition?.effect?.getTiming();
      const style = getComputedStyle(element);
      return {
        by: latest.current.reduce((sum, { element: panel, finalWidth }) =>
          panel && finalWidth !== null ? sum + panel.getBoundingClientRect().width - finalWidth : sum, 0),
        duration: typeof timing?.duration === "number" ? timing.duration : parseFloat(style.transitionDuration) * 1000 || 0,
        easing: timing?.easing ?? style.transitionTimingFunction ?? "ease",
        startTime: typeof transition?.startTime === "number" ? transition.startTime : null,
      };
    };
    const start = (e: Event) => {
      if (!own(e)) return;
      const element = e.currentTarget as HTMLElement;
      const slide = latest.current.find((panel) => panel.element === element)?.finalWidth === null ? null : slideOf(element);
      flushSync(() => setState((s) => ({ running: s.running + 1, slide: slide ?? s.slide })));
    };
    const stop = (e: Event) => {
      if (!own(e)) return;
      // 中途反向时 Chromium 先发取消，新过渡的 transitionrun 下一帧才到：slide 先留着，墙不按中途的宽度多排一次。
      const replaced = e.type === "transitioncancel" && widthTransition(e.currentTarget as HTMLElement) !== undefined;
      flushSync(() => setState((s) => (s.running <= 1 ? { running: 0, slide: replaced ? s.slide : null } : { ...s, running: s.running - 1 })));
    };
    for (const element of elements) {
      element.addEventListener("transitionrun", start);
      element.addEventListener("transitionend", stop);
      element.addEventListener("transitioncancel", stop);
    }
    return () => {
      for (const element of elements) {
        element.removeEventListener("transitionrun", start);
        element.removeEventListener("transitionend", stop);
        element.removeEventListener("transitioncancel", stop);
      }
      setState({ running: 0, slide: null });
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: 只在面板元素换了时重装监听（面板个数不变）；其余从 latest 读
  }, panels.map((panel) => panel.element));
  return state.slide;
}
