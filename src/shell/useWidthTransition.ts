import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * 元素自身的宽度过渡进行中时为真（#162）：从 transitionrun 到 transitionend／transitioncancel。
 * 过渡中途反向时旧的取消、新的开始，两个事件的先后不定，所以按进行中的个数计。
 * 子元素冒上来的过渡与其他属性不算。元素换掉或卸载时归零。
 * 浏览器在同一帧里先派发过渡事件、后报告尺寸变化，所以在事件里同步提交，赶在尺寸观察之前。
 */
export function useWidthTransition(element: HTMLElement | null): boolean {
  const [running, setRunning] = useState(0);
  useEffect(() => {
    setRunning(0);
    if (!element) return;
    const own = (e: Event) => e.target === element && (e as TransitionEvent).propertyName === "width";
    const start = (e: Event) => { if (own(e)) flushSync(() => setRunning((n) => n + 1)); };
    const stop = (e: Event) => { if (own(e)) flushSync(() => setRunning((n) => Math.max(0, n - 1))); };
    element.addEventListener("transitionrun", start);
    element.addEventListener("transitionend", stop);
    element.addEventListener("transitioncancel", stop);
    return () => {
      element.removeEventListener("transitionrun", start);
      element.removeEventListener("transitionend", stop);
      element.removeEventListener("transitioncancel", stop);
      setRunning(0);
    };
  }, [element]);
  return running > 0;
}
