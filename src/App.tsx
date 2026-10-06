import { useCallback, useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import { appInfo, currentLibrary, onLibraryEvent, resolveSearch } from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { LibraryPicker } from "./library/LibraryPicker";
import { SelectionPanel } from "./library/SelectionPanel";
import { SidebarPane } from "./library/SidebarPane";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { SettingsPanel } from "./SettingsPanel";
import { TaggingIndicator } from "./TaggingIndicator";
import { scopeKey, Wall } from "./wall/Wall";

/** 真正打开另一资料库时重建工作区；新建表单只隐藏它，继续接收当前库的导入事件。 */
function LibraryWorkspace({ library, hidden }: { library: LibraryInfo; hidden: boolean }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [scope, setScope] = useState<BrowseScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchInput>({ conditions: [] });
  const [tree, setTree] = useState<ConditionTree>({ conditions: [] });
  /** 词表或图片变化时递增：重新解析条件（标签可能改名、删除或新增了叫法）。 */
  const [vocabularyKey, setVocabularyKey] = useState(0);
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
        case "listStale":
          setReloadKey((k) => k + 1);
          break;
        case "vocabularyChanged":
        case "imagesChanged":
          setVocabularyKey((k) => k + 1);
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
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [library.id]);

  // 条件变化时由 Search 解析成条件树，图片墙按它浏览。
  const searching = search.conditions.length > 0;
  useEffect(() => {
    if (!searching) {
      setTree((prev) => (prev.conditions.length ? { conditions: [] } : prev));
      return;
    }
    let alive = true;
    resolveSearch(library.id, search, UI_LANG).then(
      (next) => {
        if (!alive) return;
        setTree(next);
        // 同一棵条件树的结果也可能变了（图片的标签变了），保持位置重新浏览。
        if (vocabularyKey) setReloadKey((k) => k + 1);
      },
      (e) => alive && setProblem(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [library.id, search, searching, vocabularyKey]);

  const started = (taskId: string) => {
    setReport(null);
    setRunning((r) => r ?? { taskId, progress: { done: 0, total: 0 } });
  };

  return (
    <div className="app-workspace" hidden={hidden}>
      <header className="app-toolbar">
        <h1 className="app-library-name">{library.name}</h1>
        <ImportBar enabled={!hidden} libraryId={library.id} libraryName={library.name} running={running} report={report}
          onStarted={started} onDismissReport={() => setReport(null)} />
      </header>
      <div className="app-body">
        <SidebarPane libraryId={library.id} scope={scope} onScope={changeScope} reloadKey={reloadKey} onError={onError} />
        <main className="app-main">
          <SearchBox libraryId={library.id} input={search} tree={searching ? tree : null} onChange={(next) => { setSearch(next); setSelected(new Set()); }} />
          {problem && <p className="app-problem" role="alert">{problem}
            <button type="button" onClick={() => setProblem(null)}>知道了</button>
          </p>}
          {selected.size > 0 && <SelectionPanel libraryId={library.id} scope={scope} selected={selected}
            onClear={() => setSelected(new Set())} reloadKey={reloadKey} onError={onError} />}
          <Wall key={`${scopeKey(scope)}/${JSON.stringify(tree)}`} conditions={tree} libraryId={library.id} scope={scope} reloadKey={reloadKey}
            selected={selected} onSelectionChange={setSelected} />
        </main>
      </div>
    </div>
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
      {library && (
        <LibraryWorkspace key={`${library.id}/${library.root}`} library={library} hidden={showCreate} />
      )}
      {(!library || showCreate) && (
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
        {library && <TaggingIndicator key={`${library.id}/${library.root}`} libraryId={library.id} />}
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
