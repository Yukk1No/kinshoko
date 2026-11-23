import { useRef } from "react";

/**
 * 对话框内容随状态出现时，关上后状态立刻变回 null，内容跟着消失，关闭动画只剩一个空壳（#448）。
 * 这里在值变回 null 后仍返回上一次的值，让内容留到关闭动画结束；Popup 卸下后不再渲染，留着也无妨。
 */
export function useLingering<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}
