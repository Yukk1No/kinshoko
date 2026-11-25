import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "../ui/reducedMotion";

export type PageSwapPhase = "in" | "out-start" | "out";

/**
 * 与 `.app-workspace[data-swap]` 的动画同长（page-swap.css）：订阅页等 --t-fast 再用 --t-pop 淡入，侧栏收起
 * （--t-slow）也在这段里。时长从令牌读，不另写数值。
 */
export function pageSwapMs() {
  const style = getComputedStyle(document.documentElement);
  const ms = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  return Math.max(ms("--t-fast") + ms("--t-pop"), ms("--t-slow"));
}

/**
 * 图片页与订阅页之间的过渡（#461 待定 5，维护者选 B）：去订阅页时侧栏收起、订阅页盖在上面淡入；回来时订阅页
 * 淡出、侧栏从零展开。`phase` 只在过渡中不为 null：
 * - `in`：工作区还留着、侧栏收着，订阅页在上面淡入；
 * - `out-start`：工作区刚露出来、侧栏先收着（下一帧才展开，宽度才有过渡）；
 * - `out`：侧栏展开，订阅页在上面淡出。
 * 减弱动效时没有过渡，直接换。
 */
export function usePageSwap(subscriptionsShown: boolean) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<PageSwapPhase | null>(null);
  const previous = useRef(subscriptionsShown);
  // 在绘制之前定下阶段，免得先闪一帧没有过渡的样子。
  useLayoutEffect(() => {
    if (previous.current === subscriptionsShown) return;
    previous.current = subscriptionsShown;
    setPhase(reduced ? null : subscriptionsShown ? "in" : "out-start");
  }, [subscriptionsShown, reduced]);
  useEffect(() => {
    if (phase === null) return;
    if (phase === "out-start") {
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPhase("out"));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    const timer = setTimeout(() => setPhase(null), pageSwapMs());
    return () => clearTimeout(timer);
  }, [phase]);
  return {
    phase,
    /** 工作区的侧栏这一刻要收着。 */
    paneHeld: phase === "in" || phase === "out-start",
    /** 订阅页已经关了、还在淡出。 */
    subscriptionsLeaving: phase === "out-start" || phase === "out",
  };
}
