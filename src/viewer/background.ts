import type { ViewerBackground } from "../bindings/ViewerBackground";
/** 首帧用的本机缓存：核心设置要等一次异步调用才回来，这之前先用上次的值，背景不会闪。以核心设置为准。 */
export function cachedViewerBackground(): ViewerBackground {
  try {
    const saved = localStorage.getItem("kinshoko.viewer.background");
    if (saved === "dark" || saved === "mid" || saved === "light" || saved === "checker") return saved;
  } catch { /* 忽略失败：本机存储不可用时用同一个默认值。 */ }
  return "mid";
}
export function rememberViewerBackground(background: ViewerBackground) {
  try { localStorage.setItem("kinshoko.viewer.background",background); } catch { /* 忽略失败：核心设置仍会记下这次的选择。 */ }
}
