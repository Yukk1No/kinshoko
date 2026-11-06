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

/**
 * 面板自身的宽度过渡进行中时给出 PanelSlide，否则为 null。过渡一开始就知道终点，
 * 图片墙可以直接按终点宽度排好，让卡片和面板同起同落，不跟着面板平移后再折回来。
 * `finalWidth` 是面板这次开合的终点宽度；面板浮在墙上、不占墙的宽度时传 null。
 * 计数、只认自身 width 过渡、在事件里同步提交的做法与 useWidthTransition 相同（#162）。
 */
export function usePanelSlide(element: HTMLElement | null, finalWidth: number | null): PanelSlide | null {
  const final = useRef(finalWidth);
  final.current = finalWidth;
  const [state, setState] = useState<{ running: number; slide: PanelSlide | null }>({ running: 0, slide: null });
  useEffect(() => {
    setState({ running: 0, slide: null });
    if (!element) return;
    const own = (e: Event) => e.target === element && (e as TransitionEvent).propertyName === "width";
    const start = (e: Event) => {
      if (!own(e)) return;
      const transition = element.getAnimations?.().find((a) => (a as CSSTransition).transitionProperty === "width");
      const timing = transition?.effect?.getTiming();
      const style = getComputedStyle(element);
      const slide: PanelSlide | null = final.current === null ? null : {
        by: element.getBoundingClientRect().width - final.current,
        duration: typeof timing?.duration === "number" ? timing.duration : parseFloat(style.transitionDuration) * 1000 || 0,
        easing: timing?.easing ?? style.transitionTimingFunction ?? "ease",
        startTime: typeof transition?.startTime === "number" ? transition.startTime : null,
      };
      flushSync(() => setState((s) => ({ running: s.running + 1, slide })));
    };
    const stop = (e: Event) => {
      if (own(e)) flushSync(() => setState((s) => (s.running <= 1 ? { running: 0, slide: null } : { ...s, running: s.running - 1 })));
    };
    element.addEventListener("transitionrun", start);
    element.addEventListener("transitionend", stop);
    element.addEventListener("transitioncancel", stop);
    return () => {
      element.removeEventListener("transitionrun", start);
      element.removeEventListener("transitionend", stop);
      element.removeEventListener("transitioncancel", stop);
      setState({ running: 0, slide: null });
    };
  }, [element]);
  return state.slide;
}
