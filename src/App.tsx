import { useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import { appInfo } from "./ipc";
import { SettingsPanel } from "./SettingsPanel";

/** 主窗口。首版骨架只有空的主区域、设置面板和状态栏。 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => {
      if (alive) setInfo(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app">
      <main className="app-main" />
      {showSettings && <SettingsPanel />}
      <footer className="app-status">
        <span>{info && `${info.productName} ${info.version}`}</span>
        <button
          type="button"
          aria-pressed={showSettings}
          onClick={() => setShowSettings((shown) => !shown)}
        >
          设置
        </button>
      </footer>
    </div>
  );
}
