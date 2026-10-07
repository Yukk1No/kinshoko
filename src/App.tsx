import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { ImportReport } from "./bindings/ImportReport";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import {
  appInfo,
  currentLibrary,
  onLibraryEvent,
  resolveSearch,
  safeMode,
  setSafeMode,
  shellSettings,
} from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { ImportBar, type RunningImport } from "./library/ImportBar";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { SelectionPanel } from "./library/SelectionPanel";
import { SidebarPane } from "./library/SidebarPane";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { ModelSettings } from "./ModelSettings";
import { SealBook } from "./SealBook";
import { SettingsPanel } from "./SettingsPanel";
import { TaggingIndicator } from "./TaggingIndicator";
import { UpdateBanner } from "./Update";
import { scopeKey, Wall } from "./wall/Wall";

/**
 * 主窗口：打开上次的资料库（没有时引导建库），导入，在侧栏切换全部／文件夹／回收站，
 * 按搜索框的条件查找，在图片墙浏览并整理选中的图；状态栏可打开设置。
 * 封印书或 Ctrl+Shift+S 切换安全模式（#60）：开启的那一刻先遮住将被封印的图，资料库确认后
 * 它们离开图片墙，计数与候选随之刷新。
 */
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
  const [scope, setScope] = useState<BrowseScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchInput>({ conditions: [], exact: false });
  /** 设置“显示相近标签来源（内置／个人）”，默认不显示。 */
  const [showApproxSource, setShowApproxSource] = useState(false);
  const [tree, setTree] = useState<ConditionTree>({ conditions: [] });
  /** 词表或图片变化时递增：重新解析条件（标签可能改名、删除或新增了叫法）。 */
  const [vocabularyKey, setVocabularyKey] = useState(0);
  const onError = useCallback((message: string) => setProblem(message), []);
  /** 安全模式。读到设置之前按开启处理，不会先露出被封印的图。 */
  const [safe, setSafe] = useState(true);
  const safeRef = useRef(true);
  safeRef.current = safe;
  const toggleSafe = useCallback(() => {
    const next = !safeRef.current;
    // 不等后端：这一帧就开始遮蔽（或准备释放）。
    safeRef.current = next;
    setSafe(next);
    setSafeMode(next).catch((e) => {
      setProblem(`无法切换安全模式：${String(e)}`);
      safeMode().then(
        (on) => setSafe(on !== false),
        () => setSafe(true),
      );
    });
  }, []);
  const changeScope = (next: BrowseScope) => {
    setScope(next);
    setSelected(new Set());
  };

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => alive && setInfo(value));
    safeMode().then(
      (on) => alive && setSafe(on !== false),
      () => {},
    );
    shellSettings().then(
      (view) => alive && view && setShowApproxSource(view.showApproxSource),
      () => undefined,
    );
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleSafe();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSafe]);

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
        case "safeModeChanged":
          setSafe(event.on);
          // 选中的图可能已被封印：开启时清掉选择（查看单张时也就回到图片墙）。
          if (event.on) setSelected(new Set());
          setReloadKey((k) => k + 1);
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
          <div className="app-body">
            <SidebarPane
              scope={scope}
              onScope={changeScope}
              reloadKey={reloadKey}
              onError={onError}
            />
            <main className="app-main">
              <SearchBox
                input={search}
                tree={searching ? tree : null}
                showSource={showApproxSource}
                onError={onError}
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
              {selected.size > 0 && (
                <SelectionPanel
                  scope={scope}
                  selected={selected}
                  onClear={() => setSelected(new Set())}
                  reloadKey={reloadKey}
                  onError={onError}
                  safeMode={safe}
                />
              )}
              <Wall
                key={`${library.id}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
                libraryId={library.id}
                scope={scope}
                conditions={tree}
                reloadKey={reloadKey}
                safeMode={safe}
                selected={selected}
                onSelectionChange={setSelected}
              />
            </main>
          </div>
        </>
      ) : (
        <main className="app-main app-main-centered">
          {openError && <p role="alert">上次的资料库无法打开：{openError}</p>}
          {library === null && <CreateLibrary onCreated={setLibrary} />}
        </main>
      )}
      {showCaptures && <CaptureHistoryPanel libraryId={library?.id} />}
      {showSettings && (
        <>
          <SettingsPanel
            library={library ?? null}
            onChange={(view) => setShowApproxSource(view.showApproxSource)}
          />
          <ModelSettings />
        </>
      )}
      <UpdateBanner />
      <footer className="app-status">
        <span>{info && `${info.productName} ${info.version}`}</span>
        <span className="app-status-actions">
          {library && <TaggingIndicator key={library.id} />}
          <SealBook on={safe} onToggle={toggleSafe} />
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
