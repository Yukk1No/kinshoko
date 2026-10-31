import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glyphGrid, glyphPath, snapGlyph, type GlyphKind } from "./winGlyphs";

/** The window this page runs in; null outside Tauri (tests without a mocked window, plain browser). */
function currentWindow() {
  try { return getCurrentWindow(); } catch { return null; }
}

function Glyph({ kind, dpr }: { kind: GlyphKind; dpr: number }) {
  const grid = glyphGrid(dpr), css = grid.size / dpr;
  return <svg width={css} height={css} viewBox={`0 0 ${grid.size} ${grid.size}`} fill="none" stroke="currentColor" strokeWidth={grid.stroke} aria-hidden="true"
    style={{ left: `calc(50% - ${css / 2}px)`, top: `calc(50% - ${css / 2}px)` }}>
    <path d={glyphPath(kind, grid)} />
  </svg>;
}

/** Keeps each glyph in `group` on whole device pixels as the controls move (window resize, scale change, panel transitions). */
function useSnappedGlyphs(group: RefObject<HTMLDivElement | null>, maximized: boolean) {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useLayoutEffect(() => {
    const snap = () => {
      const now = window.devicePixelRatio || 1;
      if (now !== dpr) { setDpr(now); return; }
      const size = glyphGrid(dpr).size;
      for (const button of group.current?.querySelectorAll<HTMLElement>(".k-win-btn") ?? []) {
        const svg = button.querySelector("svg");
        if (!svg) continue;
        const at = snapGlyph(button.getBoundingClientRect(), size, dpr);
        svg.style.left = `${at.left}px`;
        svg.style.top = `${at.top}px`;
      }
    };
    snap();
    // A scale change (another monitor, display settings) need not resize the viewport, so watch the resolution too.
    const scale = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    scale?.addEventListener("change", snap);
    window.addEventListener("resize", snap);
    document.addEventListener("transitionend", snap, true);
    return () => {
      scale?.removeEventListener("change", snap);
      window.removeEventListener("resize", snap);
      document.removeEventListener("transitionend", snap, true);
    };
  }, [group, dpr, maximized]);
  return dpr;
}

/**
 * Window controls for the frameless main window (design/ui-system/README.md, 窗口框架).
 * They sit at the end of whichever header row is right-most; that row is the window's safe area.
 * Maximized or not, they keep the same size, inset and corners; only the middle glyph changes to restore.
 * Closing keeps today's semantics: only this window closes, Kinshoko stays in the tray (ADR 0004).
 */
export function WinCtrls() {
  const { t } = useTranslation("shell");
  const [maximized, setMaximized] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const dpr = useSnappedGlyphs(group, maximized);
  useEffect(() => {
    let alive = true;
    const win = currentWindow();
    if (!win) return;
    const read = () => void win.isMaximized().then((value) => { if (alive) setMaximized(value); }, () => {});
    read();
    const stop = win.onResized(read).catch(() => () => {});
    return () => { alive = false; void stop.then((unlisten) => unlisten()); };
  }, []);
  const run = (action: (win: NonNullable<ReturnType<typeof currentWindow>>) => Promise<void>) => () => {
    const win = currentWindow();
    if (win) void action(win).catch(() => {});
  };
  return <div ref={group} className="k-win-ctrls">
    <span className="k-win-div" aria-hidden="true" />
    <button type="button" className="k-win-btn" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={run((win) => win.minimize())}>
      <Glyph kind="minimize" dpr={dpr} />
    </button>
    <button type="button" className="k-win-btn" aria-label={maximized ? t("window.restore") : t("window.maximize")} title={maximized ? t("window.restore") : t("window.maximize")}
      onClick={run((win) => win.toggleMaximize())}>
      <Glyph kind={maximized ? "restore" : "maximize"} dpr={dpr} />
    </button>
    <button type="button" className="k-win-btn is-close" aria-label={t("window.close")} title={t("window.close")} onClick={run((win) => win.close())}>
      <Glyph kind="close" dpr={dpr} />
    </button>
  </div>;
}
