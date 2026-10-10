import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": true } as const;

/**
 * Window controls for the frameless main window (design/ui-system/README.md, 窗口框架).
 * They sit at the end of whichever header row is right-most; that row is the window's safe area.
 * Closing keeps today's semantics: only this window closes, Kinshoko stays in the tray (ADR 0004).
 */
export function WinCtrls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    const win = getCurrentWindow();
    const read = () => void win.isMaximized().then((value) => { if (alive) setMaximized(value); }, () => {});
    read();
    const stop = win.onResized(read);
    return () => { alive = false; void stop.then((unlisten) => unlisten()); };
  }, []);
  const run = (action: () => Promise<void>) => () => void action().catch(() => {});
  return <div className="k-win-ctrls">
    <span className="k-win-div" aria-hidden="true" />
    <button type="button" className="k-win-btn" aria-label="最小化" title="最小化" onClick={run(() => getCurrentWindow().minimize())}>
      <svg {...glyph}><path d="M1 5.5h8" /></svg>
    </button>
    <button type="button" className="k-win-btn" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"}
      onClick={run(() => getCurrentWindow().toggleMaximize())}>
      {maximized
        ? <svg {...glyph}><rect x="1" y="3" width="6" height="6" rx="1.2" /><path d="M3 3V2.2C3 1.5 3.5 1 4.2 1h3.6C8.5 1 9 1.5 9 2.2v3.6C9 6.5 8.5 7 7.8 7H7" /></svg>
        : <svg {...glyph}><rect x="1.1" y="1.1" width="7.8" height="7.8" rx="1.6" /></svg>}
    </button>
    <button type="button" className="k-win-btn is-close" aria-label="关闭" title="关闭" onClick={run(() => getCurrentWindow().close())}>
      <svg {...glyph}><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
    </button>
  </div>;
}
