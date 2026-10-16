import { captureImage, useCaptureSources } from "./desktop/captureSources";
import { onCollectionRequest, takeCollectionRequest } from "./ipc";
import { SaveDestinationProvider } from "./library/SaveDestination";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { modalOpen as anyModalOpen } from "./ui/modal";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, X } from "lucide-react";
import { ToastProvider, useToast } from "./ui/Toast";
import { WinCtrls } from "./ui/WinCtrls";
import type { AppInfo } from "./bindings/AppInfo";
import type { BrowseScope } from "./bindings/BrowseScope";
import type { ConditionTree } from "./bindings/ConditionTree";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { SearchInput } from "./bindings/SearchInput";
import type { LibraryInfo } from "./bindings/LibraryInfo";
import type { WorkspaceCard } from "./bindings/WorkspaceCard";
import type { WorkspaceScope } from "./bindings/WorkspaceScope";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import {
  appInfo,
  currentLibrary,
  isCursorExpired,
  isLensChanged,
  onLibraryEvent,
  workspaceResolve,
  workspaceStatus,
  onWorkspaceChanged,
  onSafeModeSetting,
  safeMode,
  setSafeMode,
  shellSettings,
  thumbnailUrl,
  workspaceImage,
} from "./ipc";
import { referenceCard, useOpenInKinshoko } from "./desktop/openInKinshoko";
import { CreateLibrary } from "./library/CreateLibrary";
import { type FinishedImport, type RunningImport } from "./library/ImportBar";
import { ImportMenu, type ImportControl } from "./library/ImportMenu";
import { LegacyNameMigrationNotice, LegacyNameWizard } from "./library/LegacyNameMigrationPanel";
import { WorkspacePane, WorkspaceSources } from "./library/WorkspacePane";
import type { WorkspaceCard as SourcesCard } from "./bindings/WorkspaceCard";
import { LibraryPicker } from "./library/LibraryPicker";
import { CaptureHistoryPanel } from "./desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "./desktop/ReferenceGroupsPanel";
import { SelectionPanel } from "./library/SelectionPanel";
import { TagGroupsPane } from "./library/TagGroupsPane";
import { SearchBox, UI_LANG } from "./search/SearchBox";
import { TagGroupBar } from "./search/TagGroupBar";
import { Rail, type Section } from "./shell/Rail";
import { SettingsPanel } from "./SettingsPanel";
import { BackupReminder } from "./Backup";
import { Dialog } from "@base-ui/react/dialog";
import { TaggingIndicator } from "./TaggingIndicator";
import { UpdateBanner } from "./Update";
import { scopeKey, Wall, type WallHandle, type BrowserCard } from "./wall/Wall";
import { WallMenu } from "./wall/WallMenu";
import { useWallActions } from "./wall/useWallActions";
import { DensityIsland } from "./wall/DensityIsland";
import { Viewer } from "./viewer/Viewer";
import { RuntimeNotice } from "./RuntimeSupport";

type WorkspaceProps = {
  library: LibraryInfo | null;
  captureRequest?:{id:string;stamp:number}|null;
  onCaptureRequestHandled?:()=>void;
  /** 钉图菜单“在 Kinshoko 中打开”的参考图（#106）：在查看器里打开。 */
  referenceRequest?: { libraryId: string; imageId: string; stamp: number } | null;
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
  /** 设置“切换安全模式时保留选择”；关闭时切换即清空选择和来源面板。 */
  keepSelectionOnSafe: boolean;
  /** 查看器打开／关闭：工作区外的界面（资料库选择、面板、状态栏）随之不可操作。 */
  onViewerChange: (open: boolean) => void;
  /** 顶栏下方的提示（运行时、旧名称、更新、备份提醒）。 */
  notices?: ReactNode;
};

/**
 * 同一工作区浏览已登记资料库；查找范围与活动写入资料库分别保存。
 * 活动资料库变化时取消旧导入和选择视角，保留工作区查找与滚动锚点。
 */
function LibraryWorkspace({
  library,
  captureRequest,
  onCaptureRequestHandled,
  referenceRequest,
  section,
  paneOpen,
  onPaneToggle,
  onOpenBrowse,
  libraryControls,
  hidden,
  safe,
  onSafeChanged,
  showApproxSource,
  keepSelectionOnSafe,
  onViewerChange,
  notices,
}: WorkspaceProps) {
  const keepSelectionOnSafeRef = useRef(keepSelectionOnSafe);
  keepSelectionOnSafeRef.current = keepSelectionOnSafe;
  const toast = useToast();
  const libraryId = library?.id ?? "";
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const statusRevision = useRef<string | null>(null);
  /** 已接受的查询或通知都会前进；先发的状态读取不能覆盖后来的事实。 */
  const statusObservations = useRef(0);
  const [sources, setSources] = useState<WorkspaceCard | null>(null);
  const [loadedCards, setLoadedCards] = useState<BrowserCard[]>([]);
  /** 详情预览只使用当前视角中图片墙完整接受的快照；保留的来源身份不授予像素可见性。 */
  const [previewSnapshot, setPreviewSnapshot] = useState<{ safe: boolean; reloadKey: number; cards: BrowserCard[] } | null>(null);
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>({ kind: "all" });
  const [reloadKey, setReloadKey] = useState(0);
  const [density, setDensity] = useState(240);
  /** 图片墙上 Ctrl+滚轮缩放中的预览值（#111），滑条跟着走。 */
  const [zoomPreview, setZoomPreview] = useState<number | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);
  /** 修订变化后的选择修剪：等图片墙清空（reset）再读完新的结果（loading），然后只保留仍在的图。 */
  const prune = useRef<"idle" | "reset" | "loading">("idle");
  const wall = useRef<WallHandle>(null);
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<FinishedImport | null>(null);
  const scope: BrowseScope = workspaceScope.kind === "library" ? workspaceScope.scope : { kind: "all" };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<BrowserCard | null>(null);
  /** 查看器打开时即进入框选（图片墙右键“框选局部钉住”或 F1）。 */
  const [viewCrop, setViewCrop] = useState(false);
  useEffect(() => { if (!viewing) setViewCrop(false); }, [viewing]);
  const importControl = useRef<ImportControl>(null);
  const [editingGroups, setEditingGroups] = useState(false);
  useEffect(()=>{if(captureRequest){setViewing(null);setSources(null);}},[captureRequest]);
  // 钉图菜单“在 Kinshoko 中打开”（#106）：按当前安全模式读这张参考图，读到才打开查看器。
  useEffect(() => {
    if (!referenceRequest) return;
    let alive = true;
    const { libraryId: from, imageId } = referenceRequest;
    workspaceImage(from, imageId).then(
      (detail) => { if (!alive) return; setSources(null); setViewCrop(false); setViewing(referenceCard(from, imageId, detail)); },
      (e) => { if (alive) toast?.error(`无法打开这张参考图：${String(e)}`); },
    );
    return () => { alive = false; };
  }, [referenceRequest]);
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
  /**
   * 工作区读取期间修订变了（CursorExpired）：那次读到的结果已经过时，不是要用户处理的问题。
   * 像收到变更通知一样按新修订重读；变更停下后读取成功，不留下常驻横幅（#98）。
   * 同修订的变更通知会被略过，所以不能只等通知来补读。
   */
  const onError = useCallback((message: string) => {
    // 真实错误进轻提示（#98），一直留到画师按“知道了”；没有提示容器时退回就地横幅。
    if (!isCursorExpired(message)) { if (toast) toast.error(message); else setProblem(message); return; }
    setReloadKey((k) => k + 1);
    setVocabularyKey((k) => k + 1);
  }, [toast]);
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
  const viewerChange = useRef(onViewerChange);
  viewerChange.current = onViewerChange;
  const viewerOpen = viewing !== null;
  useEffect(() => {
    if (prune.current === "reset") { if (resultCount === null) prune.current = "loading"; return; }
    if (prune.current !== "loading" || resultCount === null) return;
    prune.current = "idle";
    const present = new Set(loadedCards.map((card) => card.id));
    setSelected((previous) => {
      const kept = [...previous].filter((id) => present.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
  }, [loadedCards, resultCount]);
  /** 查看器里的上一张 / 下一张按图片墙的顺序走；走过已读到的卡片时先读下一页，读到后再换图。 */
  const viewingIndex = viewing ? loadedCards.findIndex((card) => card.id === viewing.id) : -1;
  const pendingStep = useRef<{ from: string; index: number } | null>(null);
  const step = (delta: -1 | 1) => {
    const index = viewingIndex + delta;
    const next = loadedCards[index];
    if (next) { pendingStep.current = null; setViewing(next); return; }
    if (delta === 1 && viewing && index < (resultCount ?? 0)) {
      pendingStep.current = { from: viewing.id, index };
      wall.current?.loadMore();
    }
  };
  useEffect(() => {
    const pending = pendingStep.current;
    if (!pending) return;
    // 换了图、关了查看器或结果变了：放弃这次等待。
    if (viewing?.id !== pending.from || loadedCards[pending.index - 1]?.id !== pending.from) { pendingStep.current = null; return; }
    const next = loadedCards[pending.index];
    if (next) { pendingStep.current = null; setViewing(next); }
  }, [loadedCards, viewing]);
  // 来源整理从模态对话框改为详情面板（#98）：只有查看器是模态的。
  const modalOpen = viewerOpen;
  const acceptStatus = useCallback((next: WorkspaceStatus, invalidateWall = false) => {
    statusObservations.current += 1;
    if (statusRevision.current === next.revision) return;
    if (invalidateWall) wall.current?.invalidate();
    const changed = statusRevision.current !== null;
    statusRevision.current = next.revision;
    setStatus(next);
    // 新快照先于通知到达时，同样撤销旧内容并刷新依赖；之后的同修订通知只消重。
    if (changed || invalidateWall) {
      setPreviewSnapshot(null);
      setViewing(null);
      prune.current = "reset";
      setReloadKey((k) => k + 1);
      setVocabularyKey((k) => k + 1);
    }
  }, []);
  const onWallStatus = useCallback((next: WorkspaceStatus, cards: BrowserCard[]) => {
    acceptStatus(next);
    setPreviewSnapshot({ safe, reloadKey, cards });
  }, [acceptStatus, safe, reloadKey]);
  useEffect(() => {
    viewerChange.current(modalOpen);
  }, [modalOpen]);
  useEffect(() => () => viewerChange.current(false), []);

  useEffect(() => {
    let alive = true;
    const startedAtObservation = ++statusObservations.current;
    statusRevision.current = null;
    // A response started before a notification cannot roll back the newer provider facts.
    void workspaceStatus(safe).then((next) => {
      if (alive && statusObservations.current === startedAtObservation) acceptStatus(next);
    }, (e) => { if (alive && statusObservations.current === startedAtObservation && !isLensChanged(e)) onError(String(e)); });
    const stop = onWorkspaceChanged((next) => {
      if (!alive) return;
      // Keep the explicit source dialog; it revokes stale content and revalidates on reloadKey.
      // 负责人决定（2026-10-11）：修订变化不清空选择。图片墙按新修订重读完之后，
      // 只去掉已不存在的选中图（删除、移出当前范围），详情面板随之保持打开。
      acceptStatus(next, true);
    });
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [safe, onError, acceptStatus]);
  useEffect(() => {
    // 用户偏好：默认切换即清空；保留时由重读后的修剪去掉新视角里看不到的图。
    if (!keepSelectionOnSafeRef.current) {
      setSources(null);
      setSelected(new Set());
    }
    wall.current?.invalidate();
    setPreviewSnapshot(null);
    prune.current = "reset";
    setViewing(null);
    setReloadKey((k) => k + 1);
    setVocabularyKey((k) => k + 1);
  }, [safe]);
  useEffect(() => {
    imports.current.running = null;
    setRunning(null); setReport(null); setSelected(new Set()); setViewing(null); setSources(null);
    setReloadKey((k) => k + 1);
  }, [libraryId]);
  useEffect(() => {
    let alive = true;
    const unlisten = onLibraryEvent((event) => {
      if (!alive || event.libraryId !== libraryId) return;
      const task = imports.current;
      switch (event.kind) {
        case "listStale":
          statusObservations.current += 1;
          wall.current?.invalidate();
          setPreviewSnapshot(null);
          prune.current = "reset";
          setReloadKey((k) => k + 1);
          break;
        case "vocabularyChanged":
        case "imagesChanged":
          setVocabularyKey((k) => k + 1);
          break;
        case "safeModeChanged":
          safeChanged.current(event.on);
          // 选中或正在查看的图可能已被封印：开启时关闭查看器回到图片墙；
          // 默认同时清掉选择，设为保留时由重读后的修剪只去掉被封印的图。
          if (event.on) {
            if (!keepSelectionOnSafeRef.current) setSelected(new Set());
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
  }, [libraryId]);

  // 条件变化时由 Search 解析成条件树，图片墙按它浏览。
  const searching = search.conditions.length > 0;
  useEffect(() => {
    if (!searching) {
      setTree((prev) => (prev.conditions.length ? { conditions: [] } : prev));
      return;
    }
    let alive = true;
    workspaceResolve(search, UI_LANG, safe).then(
      (next) => {
        if (!alive) return;
        setTree(next);
        setTreeSafe(safe);
        // 同一棵条件树的结果也可能变了（图片的标签变了），保持位置重新浏览。
        if (vocabularyKey) setReloadKey((k) => k + 1);
      },
      // 安全模式刚切换、资料库还没跟上：等它确认（safeModeChanged）后按新视角重新解析。
      (e) => alive && !isLensChanged(e) && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, search, searching, vocabularyKey, safe, onError]);

  /** “重新连接”：重新检查各图库是否可用（移动盘接回后），与原“刷新登记”相同的只读检查。 */
  const recheck = useCallback(() => {
    const startedAtObservation = statusObservations.current;
    void workspaceStatus(safe).then((next) => {
      if (statusObservations.current !== startedAtObservation) return;
      const changed = statusRevision.current !== next.revision;
      acceptStatus(next, true);
      if (!changed) setReloadKey((k) => k + 1);
    }, (e) => { if (!isLensChanged(e)) onError(String(e)); });
  }, [safe, onError, acceptStatus]);

  // 详情面板（#98）：明确打开的多来源整理优先；否则显示当前选择的整理。
  const [barHost, setBarHost] = useState<HTMLElement | null>(null);
  const selectionKey = [...selected].sort().join("\n");
  const [inspectorHidden, setInspectorHidden] = useState<string | null>(null);
  const eligible = selected.size > 0 && ((workspaceScope.kind === "library" && workspaceScope.libraryId === libraryId) ||
    loadedCards.filter((card) => selected.has(card.id)).every((card) => card.sources?.length === 1 && card.sources[0].libraryId === libraryId));
  // 选中一张只有一份来源、且不属于当前图库的图时，详情面板也显示它的来源整理（卡片上的来源按钮同样可打开）。
  const selectedSourceCard = !eligible && selected.size === 1
    ? loadedCards.find((card) => selected.has(card.id) && card.sources?.length && card.libraryId && card.imageId) as SourcesCard | undefined
    : undefined;
  const inspected = sources ?? selectedSourceCard ?? null;
  const inspectorContent = inspected !== null || eligible;
  const inspectorOpen = inspectorContent && !hidden && (sources !== null || inspectorHidden !== selectionKey);
  const previewId = inspected?.id ?? (eligible && selected.size === 1 ? [...selected][0] : undefined);
  const previewCard = previewSnapshot?.safe === safe && previewSnapshot.reloadKey === reloadKey
    ? previewSnapshot.cards.find((card) => card.id === previewId) : undefined;
  const closeInspector = () => { if (sources) setSources(null); else setInspectorHidden(selectionKey); };

  const started = (taskId: string) => {
    const task = imports.current;
    // 结束事件可能先于命令返回到达：任务已有终态，迟到的响应不再复活它（#76）。
    if (task.finished.has(taskId)) return;
    task.running = taskId;
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => (r?.taskId === taskId ? r : { taskId, progress: { done: 0, total: 0 } }));
  };

  // 图片墙的右键菜单与卡片快捷键（#102）。
  const { actions: wallActions, dialogs: wallDialogs } = useWallActions({
    safe, activeLibraryId: libraryId, onError,
    onOpen: (card) => { setViewCrop(false); setViewing(card); },
    onCrop: (card) => { setViewCrop(true); setViewing(card); },
    onInspect: (card) => setSources(card as WorkspaceCard),
    onChanged: () => { setReloadKey((k) => k + 1); setVocabularyKey((k) => k + 1); },
    onClearSelection: () => setSelected(new Set()),
    importFrom: (source) => importControl.current?.[source](),
    importClipboard: async () => { await importControl.current?.clipboard(); },
    onNotice: (message) => { toast?.show({ title: message, tone: "success" }); },
    selectAll: () => wall.current?.selectAll(),
    setDensity,
  });

  const libInPane = paneOpen && section === "browse";
  const sectionName = section === "groups" ? "参考组" : "截图";
  return (
    <>
    <div className="app-workspace workspace" hidden={hidden} inert={modalOpen}>
      <div className="app-body">
        <aside
          className="sidebar-slot pane"
          data-collapsed={!paneOpen}
          aria-label={section === "browse" ? "文件夹" : section === "groups" ? "参考组" : "截图历史"}
          aria-hidden={!paneOpen}
          inert={!paneOpen}
        >
          <header className="pane-head" data-tauri-drag-region>
            {section === "browse" ? <div className="pane-library">{libInPane && libraryControls}</div>
              : <h1 className="pane-title">{sectionName}</h1>}
            <button type="button" className="k-icon-btn" aria-label="收起侧栏" title="收起侧栏（Ctrl+B）" onClick={onPaneToggle}><PanelLeftClose size={16} aria-hidden="true" /></button>
          </header>
          <div className="pane-body" hidden={section !== "browse"}>
          <WorkspacePane status={status} scope={workspaceScope} activeLibraryId={libraryId} safeMode={safe}
            reloadKey={reloadKey} onError={onError} onRecheck={recheck} onScope={(next) => {
              setWorkspaceScope(next); setSelected(new Set()); setSources(null);
            }}
            foot={library && <TaggingIndicator key={`${library.id}/${library.root}`} libraryId={library.id} />}>
          </WorkspacePane>
          </div>
          {section === "groups" && <ReferenceGroupsPanel libraryId={libraryId || undefined} />}
          {section === "captures" && <CaptureHistoryPanel libraryId={libraryId || undefined} request={captureRequest} onRequestHandled={onCaptureRequestHandled} />}
        </aside>
        <main className="app-main main">
          <header className="topbar" data-tauri-drag-region>
            {!paneOpen && <button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label="展开侧栏" title="展开侧栏（Ctrl+B）"><PanelLeftOpen size={16} aria-hidden="true" /></button>}
            {!libInPane && <div className="collapsed-library">{libraryControls}</div>}
          <SearchBox
            workspace
            libraryId="workspace"
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
          <div className="bar-meta">
            <span className="result-count tabular" role="status" aria-label="查找结果">{resultCount === null ? "…" : resultCount + " 张"}</span>
          </div>
          <ImportMenu control={importControl} scope={workspaceScope} enabled={!hidden} libraryId={libraryId} libraryName={library?.name??""}
            running={running} finished={report} onStarted={started} onDismissReport={() => setReport(null)}
            onOpenTrash={(owner=libraryId) => {
              onOpenBrowse();
              setSearch({ conditions: [], exact: false });
              setWorkspaceScope({ kind: "library", libraryId:owner, scope: { kind: "trash" } });
              setSelected(new Set());
            }} />
          {!inspectorOpen && <WinCtrls />}
          </header>
          {notices}
          <div className="app-tagbar">
          <TagGroupBar workspace libraryId="workspace" safe={safe} generation={vocabularyKey} input={search}
            onChange={(next) => { setSearch(next); setSelected(new Set()); }} onError={onError} onEdit={() => setEditingGroups(true)} />
          </div>
          {/* 分组编辑器从侧栏移到标签栏的“编辑分组”（#98）。 */}
          <Dialog.Root open={editingGroups} onOpenChange={setEditingGroups}>
            <Dialog.Portal>
              <Dialog.Backdrop className="k-backdrop" />
              <Dialog.Popup className="k-dialog k-groups-dialog">
                <Dialog.Close className="k-icon-btn k-dialog-x" aria-label="关闭"><X size={16} aria-hidden="true" /></Dialog.Close>
                <Dialog.Title className="k-dialog-title">编辑分组</Dialog.Title>
                <Dialog.Description className="k-dialog-desc">各图库共用，查找时满足任一标签即可。</Dialog.Description>
                <TagGroupsPane
                  safe={safe}
                  generation={vocabularyKey}
                  onBrowse={(globalIds) => {
                    setSearch((prev) => ({
                      ...prev,
                      conditions: [{ any: globalIds.map((id) => ({ kind: "tag", id, dismissed: [] })), negate: false }],
                    }));
                    setSelected(new Set());
                    setEditingGroups(false);
                  }}
                  onError={onError}
                />
                <div className="k-dialog-foot"><span className="k-grow" /><Dialog.Close className="k-btn is-primary">完成</Dialog.Close></div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
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
            onDensityPreview={setZoomPreview}
            onDensityCommit={(value) => { setZoomPreview(null); setDensity(value); }}
            onTotalChange={setResultCount}
            key={`${JSON.stringify(workspaceScope)}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
            libraryId={libraryId || "workspace"}
            workspaceScope={workspaceScope}
            onInspectSources={(card) => { setSources(card); }}
            onCardsChange={setLoadedCards}
            onWorkspaceStatus={onWallStatus}
            scope={scope}
            conditions={tree}
            reloadKey={reloadKey}
            safeMode={safe}
            selected={selected}
            onSelectionChange={setSelected}
            onOpenImage={(card) => { setViewCrop(false); setViewing(card); }}
            viewerOpen={modalOpen}
            menu={(target) => <WallMenu target={target} scope={scope} density={density} actions={wallActions} />}
            onCardCommand={(command, cards, point) => {
              if (command === "pin") wallActions.pin(cards, point);
              else if (command === "crop") wallActions.crop(cards[0]);
              else if (command === "copy") { if (cards.length === 1) wallActions.copy(cards[0]); else if (toast) toast.show({ title: "一次只能复制一张" }); else onError("一次只能复制一张"); }
              else wallActions.edit(cards, [{ kind: "delete" }], true);
            }}
            onPaste={wallActions.importClipboard}
          />
          {/* 图片大小浮岛（#102 方案 C3）：图片墙右下角，与 Ctrl+滚轮缩放成对。 */}
          <DensityIsland value={density} preview={zoomPreview} onPreview={(v) => wall.current?.previewDensity(v)} onCommit={setDensity} />
          {/* 多选的浮动操作条（#98）：选择面板把数量与批量操作放到这里。 */}
          <div className="selbar-host" ref={setBarHost} />
        </main>
        {inspectorContent && !hidden && (
          <aside className="inspector" aria-label="详情" data-collapsed={!inspectorOpen} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
            <header className="insp-head" data-tauri-drag-region>
              <button type="button" className="k-icon-btn" aria-label="收起详情" title="收起详情" onClick={closeInspector}><PanelRightClose size={16} aria-hidden="true" /></button>
              <span className="insp-title">详情</span>
              {inspectorOpen && <WinCtrls />}
            </header>
            <div className="insp-body">
              {previewCard && !(safe && previewCard.adult) && <InspectorPreview card={previewCard} libraryId={libraryId || "workspace"} />}
              {inspected ? <WorkspaceSources key={inspected.id} card={inspected} registrations={status?.libraries ?? []} safe={safe} reloadKey={reloadKey} onClose={() => { if (sources) setSources(null); else setSelected(new Set()); }} onView={setViewing}
                onChanged={() => { setReloadKey((k) => k + 1); setVocabularyKey((k) => k + 1); }} />
              : <SelectionPanel
                libraryId={libraryId}
                scope={scope}
                bar={barHost}
                selected={new Set(loadedCards.filter((card) => selected.has(card.id)).flatMap((card) =>
                  card.sources?.filter((source) => source.libraryId === libraryId && !source.unavailable).map((source) => source.imageId) ?? []))}
                onClear={() => setSelected(new Set())}
                reloadKey={reloadKey}
                onError={onError}
                safeMode={safe}
                generation={vocabularyKey}
              />}
            </div>
          </aside>
        )}
      </div>
    </div>
    {viewing && !hidden && (
      <Viewer
        workspace
        libraryId={viewing.libraryId ?? libraryId}
        card={{ ...viewing, id: viewing.imageId ?? viewing.id }}
        sourceName={viewing.sources?.find((source) => source.libraryId === viewing.libraryId)?.libraryName}
        onClose={() => setViewing(null)}
        reloadKey={reloadKey}
        position={viewingIndex < 0 ? undefined : { index: viewingIndex, total: Math.max(resultCount ?? 0, loadedCards.length) }}
        onStep={step}
        startCrop={viewCrop}
      />
    )}
    {wallDialogs}
    </>
  );
}

/** 详情面板的预览图与图片墙同为参考图来源：截在上面时读原图像素，而不是缩略图的屏幕像素。 */
function InspectorPreview({ card, libraryId }: { card: BrowserCard; libraryId: string }) {
  const image = useRef<HTMLImageElement>(null);
  useCaptureSources(() => {
    const clip = image.current?.closest<HTMLElement>(".inspector");
    if (!image.current || !clip || anyModalOpen()) return null;
    const reference = captureImage(image.current, clip, card.libraryId ?? libraryId, card.imageId ?? card.id, card.width, card.height);
    return reference ? [reference] : [];
  }, 10);
  return <img ref={image} className="insp-preview" src={thumbnailUrl(card.thumbnail)} alt="所选参考图" draggable={false} />;
}

/**
 * 主窗口：本设备登记的资料库与一个活动资料库（#49）；上次的库不可用时仍可选择其他库、
 * 重新登记或新建。状态栏可打开截图历史与设置。
 * 封印书或 Ctrl+Shift+S 切换安全模式（#60）：开启的那一刻先遮住将被封印的图，资料库确认后
 * 它们离开图片墙，计数与候选随之刷新。安全模式属于本设备，切换资料库后沿用。
 */
export function App() {
  return <ToastProvider><MainWindow /></ToastProvider>;
}

function MainWindow() {
  useCaptureSources(() => [], -100);
  const toast = useToast();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** 确认旧名称向导：横幅或设置 › 标签的提示条打开，叠在当前界面上。 */
  const [nameWizard, setNameWizard] = useState(false);
  const [captureRequest,setCaptureRequest]=useState<{id:string;stamp:number}|null>(null);
  const collectionHandled=useCallback(()=>setCaptureRequest(null),[]);
  const [referenceRequest, setReferenceRequest] = useState<{ libraryId: string; imageId: string; stamp: number } | null>(null);
  const [section, setSection] = useState<Section>("browse");
  const [paneOpen, setPaneOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  /** 查看器打开时，工作区以外的界面不可操作（查看器是模态的）。 */
  const [viewerOpen, setViewerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // undefined：还在打开；null：没有活动资料库。
  const [library, setLibrary] = useState<LibraryInfo | null | undefined>(undefined);
  const [hasProviders, setHasProviders] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 设置“显示相近标签来源（内置／个人）”，默认不显示。 */
  const [showApproxSource, setShowApproxSource] = useState(false);
  const [keepSelectionOnSafe, setKeepSelectionOnSafe] = useState(false);
  const acceptShellSettings = useCallback((view: ShellSettingsView) => {
    setShowApproxSource(view.showApproxSource);
    setKeepSelectionOnSafe(view.keepSelectionOnSafeMode ?? false);
  }, []);
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
      toast?.error(`无法切换安全模式：${String(e)}`);
      safeMode().then(
        (on) => setSafe(on !== false),
        () => setSafe(true),
      );
    });
  }, [toast]);

  // 钉图菜单“在 Kinshoko 中打开”（#106）：参考图在查看器里打开，截图打开截图历史。
  useOpenInKinshoko((request) => {
    if (request.kind === "capture") { setSection("captures"); setPaneOpen(true); return; }
    setReferenceRequest((last) => ({ libraryId: request.libraryId, imageId: request.imageId, stamp: (last?.stamp ?? 0) + 1 }));
  });

  useEffect(()=>{
    let alive=true,stamp=0,sequence=0;
    const accept=()=>{const request=++sequence;void takeCollectionRequest().then(id=>{if(alive&&request===sequence&&id){setCaptureRequest({id,stamp:++stamp});setSection("captures");setPaneOpen(true);}});};
    const stop=onCollectionRequest(accept).then(fn=>{if(alive)accept();return fn;});
    return()=>{alive=false;void stop.then(fn=>fn());};
  },[]);

  useEffect(() => {
    let alive = true;
    appInfo().then((value) => alive && setInfo(value));
    safeMode().then(
      (on) => alive && setSafe(on !== false),
      () => {},
    );
    shellSettings().then(
      (view) => alive && view && acceptShellSettings(view),
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

  // 上次的图库打不开：报告一次，留到画师确认（原常驻横幅，#98）。
  useEffect(() => {
    if (!openError || !toast) return;
    const id = toast.error(`上次的图库无法打开：${openError}`);
    return () => toast.close(id);
  }, [openError, toast]);

  useEffect(() => {
    let alive = true;
    const accept = (status: WorkspaceStatus) => { if (alive) setHasProviders(status.libraries.length > 0); };
    workspaceStatus(safe).then(accept, () => {});
    const stop = onWorkspaceChanged(accept);
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [safe]);

  useEffect(() => {
    const stop = onSafeModeSetting((on) => { safeRef.current = on; setSafe(on); });
    return () => { void stop.then((stop) => stop()); };
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
    workspaceStatus(safe).then((status) => setHasProviders(status.libraries.length > 0), () => {});
    setOpenError(null);
    setShowCreate(false);
  };

  const libraryControls = <LibraryPicker current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />;
  const empty = (!library && !hasProviders) || showCreate;
  const notices = <>
    <RuntimeNotice hidden={showSettings || viewerOpen} />
    {library && <div inert={viewerOpen}><LegacyNameMigrationNotice libraryId={library.id} safe={safe} onOpen={() => setNameWizard(true)} /></div>}
    <UpdateBanner />
    <BackupReminder />
  </>;
  return (
    <SaveDestinationProvider safe={safe}><div className="app app-shell">
      <div className="rail-slot" inert={viewerOpen}>
        <Rail section={section} paneOpen={paneOpen} safeMode={safe} onSafeMode={toggleSafe}
          onSection={(next) => { if (next === section) setPaneOpen((open) => !open); else { setSection(next); setPaneOpen(true); } }}
          onSettings={() => setShowSettings((shown) => !shown)} />
      </div>
      <div className="app-column">
      {library !== undefined && (
        <LibraryWorkspace
          key="workspace"
          library={library}
          captureRequest={captureRequest}
          onCaptureRequestHandled={collectionHandled}
          referenceRequest={referenceRequest}
          section={section}
          paneOpen={paneOpen}
          onPaneToggle={() => setPaneOpen((open) => !open)}
          onOpenBrowse={() => { setSection("browse"); setPaneOpen(true); }}
          libraryControls={libraryControls}
          hidden={empty}
          safe={safe}
          onSafeChanged={setSafe}
          showApproxSource={showApproxSource}
          keepSelectionOnSafe={keepSelectionOnSafe}
          onViewerChange={setViewerOpen}
          notices={!empty && notices}
        />
      )}
      {empty && (
        <div className="app-empty-workspace">
          {!library && paneOpen && section !== "browse" && <aside className="pane empty-context" aria-label={section === "groups" ? "参考组" : "截图历史"}>
            <header className="pane-head" data-tauri-drag-region><h2 className="pane-title">{section === "groups" ? "参考组" : "截图"}</h2>
              <button type="button" className="k-icon-btn" aria-label="收起侧栏" title="收起侧栏" onClick={() => setPaneOpen(false)}><PanelLeftClose size={16} aria-hidden="true" /></button></header>
            {section === "groups" ? <ReferenceGroupsPanel libraryId={undefined} /> : <CaptureHistoryPanel libraryId={undefined} request={captureRequest} onRequestHandled={collectionHandled} />}
          </aside>}
        <main className="app-main app-main-centered">
          <header className="topbar is-empty" data-tauri-drag-region><span className="k-grow" /><WinCtrls /></header>
          {empty && notices}
          <div className="app-empty-body">
          {library === undefined ? (
            <p role="status">正在打开图库…</p>
          ) : (
            <>
              <CreateLibrary onCreated={changed} onBusyChange={setCreating} />
              {!library && !hasProviders && <LibraryPicker layout="inline" current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />}
              {library && (
                <button type="button" className="k-btn" disabled={creating} onClick={() => setShowCreate(false)}>
                  返回图库
                </button>
              )}
            </>
          )}
          </div>
        </main>
        </div>
      )}
      <Dialog.Root open={showSettings} onOpenChange={setShowSettings}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          <Dialog.Popup className="k-dialog k-settings-dialog">
            <Dialog.Title className="sr-only">程序设置</Dialog.Title>
            {/* 关闭按钮不归设置面板管：读取中或读取失败时也在。 */}
            <Dialog.Close className="k-icon-btn k-dialog-x" aria-label="关闭设置"><X size={16} aria-hidden="true" /></Dialog.Close>
            <SettingsPanel
              version={info && `${info.productName} ${info.version}`}
              library={library ?? null}
              safe={safe}
              onSafeMode={toggleSafe}
              onOpenNameWizard={() => setNameWizard(true)}
              onChange={acceptShellSettings}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <LegacyNameWizard open={nameWizard} onOpenChange={setNameWizard} />
      </div>
    </div></SaveDestinationProvider>
  );
}
