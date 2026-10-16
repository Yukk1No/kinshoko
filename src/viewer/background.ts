import type { ViewerBackground } from "../bindings/ViewerBackground";
/** One-time compatibility source. The core setting remains authoritative after migration/restore. */
export function legacyViewerBackground(): ViewerBackground {
  try {
    const saved = localStorage.getItem("kinshoko.viewer.background");
    if (saved === "dark" || saved === "mid" || saved === "light" || saved === "checker") return saved;
  } catch { /* Use the same default when local storage is unavailable. */ }
  return "mid";
}
export function rememberViewerBackground(background: ViewerBackground) {
  try { localStorage.setItem("kinshoko.viewer.background",background); } catch { /* The core still persists the choice. */ }
}
