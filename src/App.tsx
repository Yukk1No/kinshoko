import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { SearchInput } from "./bindings/SearchInput";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { ImageCard } from "./bindings/ImageCard";
import {
  appInfo,
  currentLibrary,
  isLensChanged,
  onLibraryEvent,
  resolveSearch,
  safeMode,
  setSafeMode,
  shellSettings,
} from "./ipc";
import { CreateLibrary } from "./library/CreateLibrary";
import { type FinishedImport, type RunningImport } from "./library/ImportBar";
import { ImportMenu } from "./library/ImportMenu";
import { LibraryPicker } from "./library/LibraryPicker";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "./desktop/ReferenceGroupsPanel";
import { SelectionPanel } from "./library/SelectionPanel";
import { SidebarPane } from "./library/SidebarPane";
import { TagGroupsPane } from "./library/TagGroupsPane";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { TagGroupBar } from "./search/TagGroupBar";
import { ModelSettings } from "./ModelSettings";
import { Rail, type Section } from "./shell/Rail";
import { SettingsPanel } from "./SettingsPanel";
import { BackupReminder, BackupSettings } from "./Backup";
import { TaggingIndicator } from "./TaggingIndicator";
import { UpdateBanner } from "./Update";
import { scopeKey, Wall, type WallHandle } from "./wall/Wall";
import { DensitySlider } from "./wall/DensitySlider";
import { Viewer } from "./viewer/Viewer";

type WorkspaceProps = {
  library: LibraryInfo;
  section: Section;
  paneOpen: boolean;
  onPaneToggle: () => void;
  onOpenBrowse: () => void;
  libraryControls: ReactNode;
  /** 新建资料库表单打开时只隐藏工作区，继续接收当前库的导入事件。 */
  hidden: boolean;
  safe: boolean;
  /** 资料库确认安全模式已切换（`safeModeChanged`）。 */
  onSafeChanged: (on: boolean) => void;
  showApproxSource: boolean;
  /** 查看器打开／关闭：工作区外的界面（资料库选择、面板、状态栏）随之不可操作。 */
  onViewerChange: (open: boolean) => void;
};

/**
 * 一个资料库的工作区：导入，在侧栏切换全部／文件夹／回收站，按搜索框的条件查找，在图片墙浏览
 * 并整理选中的图。真正打开另一资料库时整个重建，旧库的迟到结果不会出现在新库界面（#49）。
 */
function LibraryWorkspace({
  library,
  section,
  paneOpen,
  onPaneToggle,
  onOpenBrowse,
  libraryControls,
  hidden,
  safe,
  onSafeChanged,
  showApproxSource,
  onViewerChange,
}: WorkspaceProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [density, setDensity] = useState(240);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const wall = useRef<WallHandle>(null);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<FinishedImport | null>(null);
  const [scope, setScope] = useState<BrowseScope>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<ImageCard | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchInput>({ conditions: [], exact: false });
  const [tree, setTree] = useState<ConditionTree>({ conditions: [] });
  /** 条件树是在哪个视角下解析的：与当前不同时，搜索框不显示它展开的标签名（#76）。 */
  const [treeSafe, setTreeSafe] = useState(safe);
  /**
   * 词表代次：词表、图片或安全模式变化时递增，重新解析条件、重新取得候选（标签可能改名、
   * 删除、新增了叫法，或在安全模式下被封印）。与后端 Search 缓存的修订号和安全模式对应。
   */
  const [vocabularyKey, setVocabularyKey] = useState(0);
  const onError = useCallback((message: string) => setProblem(message), []);
  /**
   * 导入任务按 id 记下终态（#76）：结束事件、启动命令的响应与进度事件到达的顺序不定，
   * 已结束的任务不能被迟到的响应或进度复活，旧任务的事件也不能覆盖正在进行的新任务。
   */
  const imports = useRef({
    finished: new Set<string>(),
    running: null as string | null,
    /** 正在进行的是另一个任务。 */
    other(taskId: string) {
      return this.running !== null && this.running !== taskId;
    },
  });
  const safeChanged = useRef(onSafeChanged);
  safeChanged.current = onSafeChanged;
  const changeScope = (next: BrowseScope) => {
    setScope(next);
    setSelected(new Set());
  };
  const viewerChange = useRef(onViewerChange);
  viewerChange.current = onViewerChange;
  const viewerOpen = viewing !== null;
  useEffect(() => {
    viewerChange.current(viewerOpen);
  }, [viewerOpen]);
  useEffect(() => () => viewerChange.current(false), []);

  useEffect(() => {
    let alive = true;
    const unlisten = onLibraryEvent((event) => {
      if (!alive || event.libraryId !== library.id) return;
      const task = imports.current;
      switch (event.kind) {
        case "listStale":
          setReloadKey((k) => k + 1);
          break;
        case "vocabularyChanged":
        case "imagesChanged":
          setVocabularyKey((k) => k + 1);
          break;
        case "safeModeChanged":
          safeChanged.current(event.on);
          // 选中或正在查看的图可能已被封印：开启时清掉选择，关闭查看器回到图片墙。
          if (event.on) {
            setSelected(new Set());
            setViewing(null);
          }
          setReloadKey((k) => k + 1);
          setVocabularyKey((k) => k + 1);
          break;
        case "taskProgress":
          // 已结束的任务不再复活；另一个任务正在进行时，旧任务的进度不覆盖它。
          if (task.finished.has(event.taskId) || task.other(event.taskId)) break;
          task.running = event.taskId;
          setRunning({ taskId: event.taskId, progress: event.progress });
          break;
        case "taskFinished":
          if (task.finished.has(event.taskId) || task.other(event.taskId)) break;
          task.finished.add(event.taskId);
          task.running = null;
          setRunning(null);
          setReport({ taskId: event.taskId, report: event.report });
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
    resolveSearch(library.id, search, UI_LANG, safe).then(
      (next) => {
        if (!alive) return;
        setTree(next);
        setTreeSafe(safe);
        // 同一棵条件树的结果也可能变了（图片的标签变了），保持位置重新浏览。
        if (vocabularyKey) setReloadKey((k) => k + 1);
      },
      // 安全模式刚切换、资料库还没跟上：等它确认（safeModeChanged）后按新视角重新解析。
      (e) => alive && !isLensChanged(e) && setProblem(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [library.id, search, searching, vocabularyKey, safe]);

  const started = (taskId: string) => {
    const task = imports.current;
    // 结束事件可能先于命令返回到达：任务已有终态，迟到的响应不再复活它（#76）。
    if (task.finished.has(taskId)) return;
    task.running = taskId;
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => (r?.taskId === taskId ? r : { taskId, progress: { done: 0, total: 0 } }));
  };

  const libInPane = paneOpen && section === "browse";
  return (
    <>
    <div className="app-workspace workspace" hidden={hidden} inert={viewerOpen}>
      <div className="app-body">
        <aside
          className="sidebar-slot pane"
          data-collapsed={!paneOpen}
          aria-label={section === "browse" ? "文件夹" : section === "groups" ? "参考组" : "截图历史"}
          aria-hidden={!paneOpen}
          inert={!paneOpen}
        >
          <header className="pane-head">
            <h1 className="app-library-name">{section === "browse" ? library.name : section === "groups" ? "参考组" : "截图历史"}</h1>
            <button type="button" className="icon-tool" aria-label="收起侧栏" title="收起（Ctrl+B）" onClick={onPaneToggle}>‹</button>
          </header>
          <div className="pane-body" hidden={section !== "browse"}>
            {libInPane && libraryControls}
          <SidebarPane
            libraryId={library.id}
            scope={scope}
            onScope={changeScope}
            reloadKey={reloadKey}
            onError={onError}
          />
          <details className="tag-organize"><summary>整理标签分组</summary>
          <TagGroupsPane
            libraryId={library.id}
            safe={safe}
            generation={vocabularyKey}
            onBrowse={(ids) => {
              setSearch((prev) => ({
                ...prev,
                conditions: [{ any: ids.map((id) => ({ kind: "tag", id, dismissed: [] })), negate: false }],
              }));
              setSelected(new Set());
            }}
            onError={onError}
          />
          </details>
          {/* Ctrl／Shift／空格选择后的整理入口沿用正式 IPC。 */}
          {selected.size > 0 && (
            <SelectionPanel
              libraryId={library.id}
              scope={scope}
              selected={selected}
              onClear={() => setSelected(new Set())}
              reloadKey={reloadKey}
              onError={onError}
              safeMode={safe}
              generation={vocabularyKey}
            />
          )}
          </div>
          {section === "groups" && <ReferenceGroupsPanel libraryId={library.id} />}
          {section === "captures" && <CaptureHistoryPanel libraryId={library.id} />}
        </aside>
        <main className="app-main main">
          <header className="topbar">
            {!paneOpen && <button type="button" className="icon-tool" onClick={onPaneToggle} aria-label="展开侧栏" title="展开（Ctrl+B）">›</button>}
            {!libInPane && <div className="collapsed-library">{libraryControls}</div>}
          <SearchBox
            libraryId={library.id}
            safe={safe}
            generation={vocabularyKey}
            input={search}
            tree={searching && treeSafe === safe ? tree : null}
            showSource={showApproxSource}
            onError={onError}
            onChange={(next) => {
              setSearch(next);
              setSelected(new Set());
            }}
          />
          <span className="result-count tabular" role="status" aria-label="查找结果">{resultCount === null ? "…" : resultCount + " 张"}</span>
          <label className="density" title="图片大小"><span className="sr-only">图片大小</span>
            <DensitySlider value={density} onPreview={(v) => wall.current?.previewDensity(v)} onCommit={setDensity} />
          </label>
          <ImportMenu enabled={!hidden} libraryId={library.id} libraryName={library.name}
            running={running} finished={report} onStarted={started} onDismissReport={() => setReport(null)}
            onOpenTrash={() => {
              onOpenBrowse();
              setSearch({ conditions: [], exact: false });
              changeScope({ kind: "trash" });
            }} />
          </header>
          <div className="app-tagbar">
          <TagGroupBar libraryId={library.id} safe={safe} generation={vocabularyKey} input={search}
            onChange={(next) => { setSearch(next); setSelected(new Set()); }} onError={onError} />
          </div>
          {problem && (
            <p className="app-problem" role="alert">
              {problem}
              <button type="button" onClick={() => setProblem(null)}>
                知道了
              </button>
            </p>
          )}
          <Wall
            ref={wall}
            density={density}
            onTotalChange={setResultCount}
            key={`${library.id}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
            libraryId={library.id}
            scope={scope}
            conditions={tree}
            reloadKey={reloadKey}
            safeMode={safe}
            selected={selected}
            onSelectionChange={setSelected}
            onOpenImage={setViewing}
            viewerOpen={viewerOpen}
          />
        </main>
      </div>
    </div>
    {viewing && !hidden && (
      <Viewer
        libraryId={library.id}
        card={viewing}
        onClose={() => setViewing(null)}
        reloadKey={reloadKey}
      />
    )}
    </>
  );
}

/**
 * 主窗口：本设备登记的资料库与一个活动资料库（#49）；上次的库不可用时仍可选择其他库、
 * 重新登记或新建。状态栏可打开截图历史与设置。
 * 封印书或 Ctrl+Shift+S 切换安全模式（#60）：开启的那一刻先遮住将被封印的图，资料库确认后
 * 它们离开图片墙，计数与候选随之刷新。安全模式属于本设备，切换资料库后沿用。
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [section, setSection] = useState<Section>("browse");
  const [paneOpen, setPaneOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  /** 查看器打开时，工作区以外的界面不可操作（查看器是模态的）。 */
  const [viewerOpen, setViewerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // undefined：还在打开；null：没有活动资料库。
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** 设置“显示相近标签来源（内置／个人）”，默认不显示。 */
  const [showApproxSource, setShowApproxSource] = useState(false);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewerOpen || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "b") { e.preventDefault(); setPaneOpen((open) => !open); }
      if (["1", "2", "3"].includes(e.key)) {
        e.preventDefault(); setSection((["browse", "groups", "captures"] as Section[])[Number(e.key) - 1]); setPaneOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerOpen]);

  const changed = (value: LibraryInfo | null) => {
    setLibrary(value);
    setOpenError(null);
    setShowCreate(false);
  };

  const libraryControls = <LibraryPicker current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} compact={!!library} />;
  return (
    <div className="app app-shell">
      <div className="rail-slot" inert={viewerOpen}>
        <Rail section={section} paneOpen={paneOpen} safeMode={safe} onSafeMode={toggleSafe}
          onSection={(next) => { if (next === section) setPaneOpen((open) => !open); else { setSection(next); setPaneOpen(true); } }}
          onSettings={() => setShowSettings((shown) => !shown)} />
      </div>
      <div className="app-column">
      {!library && <div inert={viewerOpen}>{libraryControls}</div>}
      {openError && (
        <p className="app-problem" role="alert">
          上次的资料库无法打开：{openError}
        </p>
      )}
      {problem && (
        <p className="app-problem" role="alert">
          {problem}
          <button type="button" onClick={() => setProblem(null)}>
            知道了
          </button>
        </p>
      )}
      {library && (
        <LibraryWorkspace
          key={`${library.id}/${library.root}`}
          library={library}
          section={section}
          paneOpen={paneOpen}
          onPaneToggle={() => setPaneOpen((open) => !open)}
          onOpenBrowse={() => { setSection("browse"); setPaneOpen(true); }}
          libraryControls={libraryControls}
          hidden={showCreate}
          safe={safe}
          onSafeChanged={setSafe}
          showApproxSource={showApproxSource}
          onViewerChange={setViewerOpen}
        />
      )}
      {(!library || showCreate) && (
        <div className="app-empty-workspace">
          {!library && paneOpen && section !== "browse" && <aside className="pane empty-context" aria-label={section === "groups" ? "参考组" : "截图历史"}>
            <header className="pane-head"><h2>{section === "groups" ? "参考组" : "截图历史"}</h2><button type="button" className="icon-tool" aria-label="收起侧栏" onClick={() => setPaneOpen(false)}>‹</button></header>
            {section === "groups" ? <ReferenceGroupsPanel libraryId={undefined} /> : <CaptureHistoryPanel libraryId={undefined} />}
          </aside>}
        <main className="app-main app-main-centered">
          {library === undefined ? (
            <p role="status">正在打开资料库…</p>
          ) : (
            <>
              <CreateLibrary onCreated={changed} onBusyChange={setCreating} />
              {library && (
                <button type="button" disabled={creating} onClick={() => setShowCreate(false)}>
                  返回资料库
                </button>
              )}
            </>
          )}
        </main>
        </div>
      )}
      {showSettings && (
        <div className="settings-overlay" role="dialog" aria-label="程序设置" inert={viewerOpen}>
          <header><h2>程序设置</h2><button type="button" onClick={() => setShowSettings(false)}>关闭设置</button></header>
          <SettingsPanel
            library={library ?? null}
            onChange={(view) => setShowApproxSource(view.showApproxSource)}
          />
          <ModelSettings />
          <BackupSettings />
        </div>
      )}
      <UpdateBanner />
      <BackupReminder />
      <footer className="app-status" inert={viewerOpen}>
        <span>{info && `${info.productName} ${info.version}`}</span>
        <span className="app-status-actions">
          {library && <TaggingIndicator key={`${library.id}/${library.root}`} libraryId={library.id} />}
        </span>
      </footer>
      </div>
    </div>
  );
}
