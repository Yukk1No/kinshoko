import { useCallback, useEffect, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { ImageCard } from "./bindings/ImageCard";
import { appInfo, currentLibrary, onLibraryEvent, resolveSearch } from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { SelectionPanel } from "./library/SelectionPanel";
import { SidebarPane } from "./library/SidebarPane";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { SettingsPanel } from "./SettingsPanel";
import { TaggingIndicator } from "./TaggingIndicator";
import { scopeKey, Wall } from "./wall/Wall";
import { Viewer } from "./viewer/Viewer";

/**
 * 主窗口：打开上次的资料库（没有时引导建库），导入，在侧栏切换全部／文件夹／回收站，
 * 按搜索框的条件查找，在图片墙浏览并整理选中的图；状态栏可打开设置。
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // undefined：还在打开；null：本设备还没有资料库。
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [scope, setScope] = useState<BrowseScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<ImageCard | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarMoving, setSidebarMoving] = useState(false);
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
  const toggleSidebar = () => {
    setSidebarMoving(!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    setSidebarCollapsed((collapsed) => !collapsed);
  };
  useEffect(() => {
    if (!sidebarMoving) return;
    const timer = window.setTimeout(() => setSidebarMoving(false), 280);
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed, sidebarMoving]);

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
      void unlisten.then((stop) => stop());
    };
  }, [libraryId]);

  // 条件变化时由 Search 解析成条件树，图片墙按它浏览。
  const searching = search.conditions.length > 0;
  useEffect(() => {
    if (!libraryId) return;
    if (!searching) {
      setTree((prev) => (prev.conditions.length ? { conditions: [] } : prev));
      return;
    }
    let alive = true;
    resolveSearch(search, UI_LANG).then(
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
  }, [libraryId, search, searching, vocabularyKey]);

  const started = (taskId: string) => {
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => r ?? { taskId, progress: { done: 0, total: 0 } });
  };

  return (
    <div className="app">
      {library ? (
        <div className="app-workspace" inert={viewing !== null}>
          <header className="app-toolbar">
            <button type="button" aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}>
              {sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            </button>
            <h1 className="app-library-name">{library.name}</h1>
            <ImportBar
              libraryName={library.name}
              running={running}
              report={report}
              onStarted={started}
              onDismissReport={() => setReport(null)}
            />
          </header>
          <div className="app-body">
            <div className="sidebar-slot" data-collapsed={sidebarCollapsed}
              aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}
              onTransitionEnd={(e) => { if (e.target === e.currentTarget && e.propertyName === "width") setSidebarMoving(false); }}>
              <SidebarPane
                scope={scope}
                onScope={changeScope}
                reloadKey={reloadKey}
                onError={onError}
              />
              {selected.size > 0 && (
                <SelectionPanel
                  scope={scope}
                  selected={selected}
                  onClear={() => setSelected(new Set())}
                  reloadKey={reloadKey}
                  onError={onError}
                />
              )}
            </div>
            <main className="app-main">
              <SearchBox
                input={search}
                tree={searching ? tree : null}
                onChange={(next) => {
                  setSearch(next);
                  setSelected(new Set());
                }}
              />
              {problem && (
                <p className="app-problem" role="alert">
                  {problem}
                  <button type="button" onClick={() => setProblem(null)}>
                    知道了
                  </button>
                </p>
              )}
              <Wall
                key={`${library.id}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
                libraryId={library.id}
                scope={scope}
                conditions={tree}
                reloadKey={reloadKey}
                selected={selected}
                onSelectionChange={setSelected}
                onOpenImage={setViewing}
                viewerOpen={viewing !== null}
                holdReflow={sidebarMoving}
              />
            </main>
          </div>
        </div>
      ) : (
        <main className="app-main app-main-centered">
          {openError && <p role="alert">上次的资料库无法打开：{openError}</p>}
          {library === null && <CreateLibrary onCreated={setLibrary} />}
        </main>
      )}
      {library && viewing && <Viewer libraryId={library.id} card={viewing} onClose={() => setViewing(null)} />}
      {showSettings && <div inert={viewing !== null}><SettingsPanel /></div>}
      <footer className="app-status" inert={viewing !== null}>
        <span>{info && `${info.productName} ${info.version}`}</span>
        {library && <TaggingIndicator key={library.id} />}
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
