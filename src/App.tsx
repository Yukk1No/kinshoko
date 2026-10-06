import { useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import { appInfo } from "./ipc";

/** 主窗口。首版骨架只有空的主区域和状态栏。 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

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
      <footer className="app-status">
        {info && `${info.productName} ${info.version}`}
      </footer>
    </div>
  );
}
