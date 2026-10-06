import { useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import { appInfo, currentLibrary, onLibraryEvent } from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Wall } from "./wall/Wall";

/** 主窗口：打开上次的资料库（没有时引导建库），导入，并在图片墙浏览；状态栏可打开设置。 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCaptures, setShowCaptures] = useState(false);
  // undefined：还在打开；null：本设备还没有资料库。
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => alive && setInfo(value));
    currentLibrary().then(
      (value) => alive && setLibrary(value),
      (e) => {
        if (!alive) return;
        setOpenError(String(e));
        setLibrary(null);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const libraryId = library?.id;
  useEffect(() => {
    if (!libraryId) return;
    const unlisten = onLibraryEvent((event) => {
      if (event.libraryId !== libraryId) return;
      switch (event.kind) {
        case "listStale":
          setReloadKey((k) => k + 1);
          break;
        case "taskProgress":
          setRunning({ taskId: event.taskId, progress: event.progress });
          break;
        case "taskFinished":
          setRunning(null);
          setReport(event.report);
          break;
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [libraryId]);

  const started = (taskId: string) => {
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => r ?? { taskId, progress: { done: 0, total: 0 } });
  };

  return (
    <div className="app">
      {library ? (
        <>
          <header className="app-toolbar">
            <h1 className="app-library-name">{library.name}</h1>
            <ImportBar
              libraryName={library.name}
              running={running}
              report={report}
              onStarted={started}
              onDismissReport={() => setReport(null)}
            />
          </header>
          <main className="app-main">
            <Wall key={library.id} libraryId={library.id} reloadKey={reloadKey} />
          </main>
        </>
      ) : (
        <main className="app-main app-main-centered">
          {openError && <p role="alert">上次的资料库无法打开：{openError}</p>}
          {library === null && <CreateLibrary onCreated={setLibrary} />}
        </main>
      )}
      {showCaptures && <CaptureHistoryPanel libraryId={library?.id} />}
      {showSettings && <SettingsPanel />}
      <footer className="app-status">
        <span>{info && `${info.productName} ${info.version}`}</span>
        <span className="app-status-actions">
          <button
            type="button"
            aria-pressed={showCaptures}
            onClick={() => setShowCaptures((shown) => !shown)}
          >
            截图历史
          </button>
          <button
            type="button"
            aria-pressed={showSettings}
            onClick={() => setShowSettings((shown) => !shown)}
          >
            设置
          </button>
        </span>
      </footer>
    </div>
  );
}
