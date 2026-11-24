import { useSyncExternalStore } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** 系统设置此刻要求减弱动效。 */
export const reducedNow = () => window.matchMedia(REDUCED_QUERY).matches;

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 系统设置要求减弱动效时为真，随系统设置变化。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedNow);
}
