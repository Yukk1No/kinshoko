import { useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import { appInfo, currentLibrary, onLibraryEvent } from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { Wall } from "./wall/Wall";

/** 主窗口：打开上次的资料库（没有时引导建库），导入，并在图片墙浏览。 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
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
      <footer className="app-status">{info && `${info.productName} ${info.version}`}</footer>
    </div>
  );
}
