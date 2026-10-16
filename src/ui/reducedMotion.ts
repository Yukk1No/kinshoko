import { useEffect, useState } from "react";

// Reduced motion read the way the prototype reads it (`settings.reducedMotion || systemReduced()`):
// `:root[data-reduced-motion]` or the system setting.
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** 系统或程序此刻要求减少动画。 */
export const reducedNow = () =>
  !!window.matchMedia?.(REDUCED_QUERY).matches || document.documentElement.hasAttribute("data-reduced-motion");

/** 系统或程序要求减少动画时为真；随系统设置变化。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_QUERY);
    if (!query?.addEventListener) return;
    const update = () => setReduced(reducedNow());
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
