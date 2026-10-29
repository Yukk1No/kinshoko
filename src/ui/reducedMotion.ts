import { useEffect, useState } from "react";

// Reduced motion read the way the prototype reads it (`settings.reducedMotion || systemReduced()`):
// `:root[data-reduced-motion]` or the system setting.
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** 系统或程序此刻要求减少动画。 */
export const reducedNow = () =>
  !!window.matchMedia?.(REDUCED_QUERY).matches || document.documentElement.hasAttribute("data-reduced-motion");

/** 系统或程序要求减少动画时为真；随系统设置与根元素上的 data-reduced-motion 变化。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    const update = () => setReduced(reducedNow());
    const query = window.matchMedia?.(REDUCED_QUERY);
    query?.addEventListener?.("change", update);
    // 程序的减少动画开关写在根元素上，切换后立即生效。
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduced-motion"] });
    return () => { query?.removeEventListener?.("change", update); observer?.disconnect(); };
  }, []);
  return reduced;
}
