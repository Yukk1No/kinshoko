import { useCallback, useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import { appInfo, currentLibrary, onLibraryEvent } from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { LibraryPicker } from "./library/LibraryPicker";
import { SelectionPanel } from "./library/SelectionPanel";
import { SidebarPane } from "./library/SidebarPane";
import { SettingsPanel } from "./SettingsPanel";
import { scopeKey, Wall } from "./wall/Wall";

/** 每次打开另一资料库时重建整个工作区，选择、进度和迟到回调都留在旧工作区。 */
function LibraryWorkspace({ library }: { library: LibraryInfo }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [scope, setScope] = useState<BrowseScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const onError = useCallback((message: string) => setProblem(message), []);
  const changeScope = (next: BrowseScope) => {
    setScope(next);
    setSelected(new Set());
  };

  useEffect(() => {
    let alive = true;
    const unlisten = onLibraryEvent((event) => {
      if (!alive || event.libraryId !== library.id) return;
      switch (event.kind) {
        case "listStale": setReloadKey((k) => k + 1); break;
        case "taskProgress": setRunning({ taskId: event.taskId, progress: event.progress }); break;
        case "taskFinished": setRunning(null); setReport(event.report); break;
      }
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [library.id]);

  const started = (taskId: string) => {
    setReport(null);
    setRunning((r) => r ?? { taskId, progress: { done: 0, total: 0 } });
  };

  return (
    <>
      <header className="app-toolbar">
        <h1 className="app-library-name">{library.name}</h1>
        <ImportBar libraryId={library.id} libraryName={library.name} running={running} report={report}
          onStarted={started} onDismissReport={() => setReport(null)} />
      </header>
      <div className="app-body">
        <SidebarPane libraryId={library.id} scope={scope} onScope={changeScope} reloadKey={reloadKey} onError={onError} />
        <main className="app-main">
          {problem && <p className="app-problem" role="alert">{problem}
            <button type="button" onClick={() => setProblem(null)}>知道了</button>
          </p>}
          {selected.size > 0 && <SelectionPanel libraryId={library.id} scope={scope} selected={selected}
            onClear={() => setSelected(new Set())} reloadKey={reloadKey} onError={onError} />}
          <Wall key={scopeKey(scope)} libraryId={library.id} scope={scope} reloadKey={reloadKey}
            selected={selected} onSelectionChange={setSelected} />
        </main>
      </div>
    </>
  );
}

/** 主窗口：本设备登记与一个活动资料库；上次的库不可用时仍可选择其他库或重新登记。 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => alive && setInfo(value));
    currentLibrary().then(
      (value) => alive && setLibrary(value),
      (e) => { if (alive) { setOpenError(String(e)); setLibrary(null); } },
    );
    return () => { alive = false; };
  }, []);

  const changed = (value: LibraryInfo | null) => {
    setLibrary(value);
    setOpenError(null);
    setShowCreate(false);
  };

  return (
    <div className="app">
      <LibraryPicker current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />
      {openError && <p className="app-problem" role="alert">上次的资料库无法打开：{openError}</p>}
      {library && !showCreate ? (
        <LibraryWorkspace key={`${library.id}/${library.root}`} library={library} />
      ) : (
        <main className="app-main app-main-centered">
          {library === undefined ? <p role="status">正在打开资料库…</p> : (
            <>
              <CreateLibrary onCreated={changed} onBusyChange={setCreating} />
              {library && <button type="button" disabled={creating} onClick={() => setShowCreate(false)}>返回资料库</button>}
            </>
          )}
        </main>
      )}
      {showSettings && <SettingsPanel />}
      <footer className="app-status">
        <span>{info && `${info.productName} ${info.version}`}</span>
        <button type="button" aria-pressed={showSettings} onClick={() => setShowSettings((shown) => !shown)}>设置</button>
      </footer>
    </div>
  );
}
