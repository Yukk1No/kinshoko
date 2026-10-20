import { captureImage, useCaptureSources } from "./desktop/captureSources";
import { onCollectionRequest, takeCollectionRequest } from "./ipc";
import { SaveDestinationProvider } from "./library/SaveDestination";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { modalOpen as anyModalOpen } from "./ui/modal";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, X } from "lucide-react";
import { ToastProvider, useToast } from "./ui/Toast";
import { WinCtrls } from "./ui/WinCtrls";
import { useWidthTransition } from "./shell/useWidthTransition";
import { InspectorResizer, useInspectorWidth } from "./shell/InspectorResizer";
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
  onOrganizeWaiting,
  workspaceResolve,
  workspaceStatus,
  onWorkspaceChanged,
  onSafeModeSetting,
  safeMode,
  setSafeMode,
  setUiScale,
  shellSettings,
  setInspectorWidth,
  thumbnailUrl,
  uiScale,
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
import { initialUiScale, stepUiScale, UiScaleContext, uiScaleStepForKey } from "./shell/uiScale";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";
import { BackupReminder } from "./Backup";
import { Dialog } from "@base-ui/react/dialog";
import { TaggingActivity } from "./TaggingActivity";
import { UpdateBanner } from "./Update";
import { scopeKey, Wall, type WallHandle, type BrowserCard } from "./wall/Wall";
import { WallMenu } from "./wall/WallMenu";
import { useWallActions } from "./wall/useWallActions";
import { DensityIsland } from "./wall/DensityIsland";
import { Viewer } from "./viewer/Viewer";
import { RuntimeNotice } from "./RuntimeSupport";
import { INITIAL_SAFE_LENS, needsRecheck, reduceSafeLens, type SafeLensAction } from "./shell/safeLens";
import { safeTiming } from "./shell/safeTiming";
import type { TagDisplay } from "./bindings/TagDisplay";
import { DEFAULT_TAG_DISPLAY } from "./tags/tagConfidence";
import { TagDisplayContext } from "./tags/TagDisplayContext";

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
  /** 查询资料库用的安全模式视角：开启当即生效，关闭等后端确认（#183）。 */
  safe: boolean;
  /** 资料库确认安全模式已切换（`safeModeChanged`）。 */
  onSafeChanged: (on: boolean) => void;
  showApproxSource: boolean;
  /** 设置“切换安全模式时保留选择”；关闭时切换即清空选择和来源面板。 */
  keepSelectionOnSafe: boolean;
  /** 本设备保存的详情面板宽度（#157）；没拖过时为 undefined。 */
  inspectorWidth?: number;
  /** 拖动松手、双击或方向键定下的详情面板宽度。 */
  onInspectorWidth: (width: number) => void;
  /** 查看器打开／关闭：工作区外的界面（资料库选择、面板、状态栏）随之不可操作。 */
  onViewerChange: (open: boolean) => void;
  /** 顶栏下方的提示（运行时、旧名称、更新、备份提醒）。 */
  notices?: ReactNode;
  /** 侧栏图库标题菜单“从列表移除”之后（#114）。 */
  onLibraryRemoved?: (libraryId: string) => void;
  /** 点打标图标：打开设置 › 自动标签（#144）。 */
  onOpenTaggingSettings: () => void;
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
  inspectorWidth,
  onInspectorWidth,
  onViewerChange,
  notices,
  onLibraryRemoved,
  onOpenTaggingSettings,
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
    referenceCard(from, imageId, safe).then(
      (card) => { if (!alive) return; setSources(null); setViewCrop(false); setViewing(card); },
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
  // 图片墙按回调身份决定是否重新浏览：这里读最新的视角与重读序号，回调保持不变，
  // 安全模式切换或重读时不会因为回调换了身份再多浏览一次（#183）。
  const wallView = useRef({ safe, reloadKey });
  wallView.current = { safe, reloadKey };
  const onWallStatus = useCallback((next: WorkspaceStatus, cards: BrowserCard[]) => {
    acceptStatus(next);
    setPreviewSnapshot({ ...wallView.current, cards });
  }, [acceptStatus]);
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
  // 视角一变就在这次渲染里推进重读序号（#183）：图片墙的重新浏览与视角变化在同一次提交里、
  // 先于这里的状态与侧栏刷新发出。后端让这些查询排队用同一组资源，浏览排在后面要多等上百毫秒。
  // 旧视角还在路上的浏览由图片墙按视角作废。
  const [reloadedFor, setReloadedFor] = useState(safe);
  if (reloadedFor !== safe) {
    setReloadedFor(safe);
    setReloadKey((k) => k + 1);
  }
  useEffect(() => {
    // 用户偏好：默认切换即清空；保留时由重读后的修剪去掉新视角里看不到的图。
    if (!keepSelectionOnSafeRef.current) {
      setSources(null);
      setSelected(new Set());
    }
    setPreviewSnapshot(null);
    prune.current = "reset";
    setViewing(null);
    setVocabularyKey((k) => k + 1);
  }, [safe]);
  useEffect(() => {
    imports.current.running = null;
    setRunning(null); setReport(null); setSelected(new Set()); setViewing(null); setSources(null);
    setReloadKey((k) => k + 1);
  }, [libraryId]);
  // 整理另一个图库时它的导入正在收尾（ADR-0008，#112）：后端等收尾结束再执行，这里只给轻提示。
  useEffect(() => {
    let alive = true;
    const unlisten = onOrganizeWaiting((waiting) => {
      if (!alive) return;
      const names = waiting.finishing.map((name) => `「${name}」`).join("、");
      toast?.show({ title: "导入收尾后再整理", description: `${names}的导入完成后自动执行` });
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [toast]);
  useEffect(() => {
    let alive = true;
    const unlisten = onLibraryEvent((event) => {
      if (!alive) return;
      // 后端按需把可写句柄切到正在整理的图库（ADR-0008）：任何图库的列表或词表变化都只让界面重读；
      // 安全模式与导入事件只认这个界面打开的图库，另一个库的不串台。
      const invalidation = event.kind === "listStale" || event.kind === "vocabularyChanged" || event.kind === "imagesChanged";
      if (event.libraryId !== libraryId && !invalidation) return;
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
            setReloadKey((k) => k + 1);
            setVocabularyKey((k) => k + 1);
          } else {
            // 关闭：查询视角在后端确认时才放开，放开那一刻（下面按 safe 的效果）整批重读一次。
            // 这里再重读，会作废那次刚发出的浏览、再排一遍队，释放动画跟着推迟（#183）。
            safeTiming.mark("资料库事件");
          }
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
  // 详情面板整理哪个图库（ADR-0008，#113）：范围是某个图库时就是它；“全部图片”下选中的图都只有同一个图库的
  // 来源时是那个库。多选可以整理任何一个图库；只选一张且不在窗口打开的图库时，走下面的来源整理。
  const selectedCards = loadedCards.filter((card) => selected.has(card.id));
  const soleLibrary = selectedCards[0]?.sources?.length === 1 ? selectedCards[0].sources[0].libraryId : null;
  // 列表重读期间选中的图暂时不在已读卡片里：沿用窗口打开的图库，等修剪选择后再定（与原规则相同）。
  const selectionLibrary = workspaceScope.kind === "library" ? workspaceScope.libraryId
    : selectedCards.length === 0 ? libraryId || null
    : soleLibrary && selectedCards.every((card) => card.sources?.length === 1 && card.sources[0].libraryId === soleLibrary) ? soleLibrary : null;
  const eligible = selected.size > 0 && selectionLibrary !== null && (selected.size > 1 || selectionLibrary === libraryId);
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
  // 详情面板开合的宽度过渡中图片墙不逐帧重排，过渡结束后重排一次（#162）；拖动边缘时同样，松手后重排（#157）。
  const [inspectorElement, setInspectorElement] = useState<HTMLElement | null>(null);
  const inspectorMoving = useWidthTransition(inspectorElement);
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  const panelWidth = useInspectorWidth(draggedWidth ?? inspectorWidth);
  // 面板与右下角的任务卡片（挂在 body 上）共用这个宽度。
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${panelWidth}px`);
  }, [panelWidth]);
  useEffect(() => () => { document.documentElement.style.removeProperty("--inspector-width"); }, []);
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
          <WorkspacePane status={status} scope={workspaceScope} safeMode={safe}
            reloadKey={reloadKey} onError={onError} onRecheck={recheck} onRemoved={onLibraryRemoved} onScope={(next) => {
              setWorkspaceScope(next); setSelected(new Set()); setSources(null);
            }}>
          </WorkspacePane>
          </div>
          {section === "groups" && <ReferenceGroupsPanel libraryId={libraryId || undefined} />}
          {section === "captures" && <CaptureHistoryPanel libraryId={libraryId || undefined} request={captureRequest} onRequestHandled={onCaptureRequestHandled} />}
        </aside>
        <main className="app-main main">
          <header className="topbar" data-tauri-drag-region>
            {!paneOpen && <button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label="展开侧栏" title="展开侧栏（Ctrl+B）"><PanelLeftOpen size={16} aria-hidden="true" /></button>}
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
            holdReflow={inspectorMoving || draggedWidth !== null}
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
          {/* 图片墙右下角：打标图标（#144）在图片大小浮岛（#102 方案 C3，与 Ctrl+滚轮缩放成对）的左边。 */}
          <div className="k-wall-corner">
            {library && <TaggingActivity libraryId={library.id} registered={status?.libraries.map((entry) => entry.library.id)} onOpenSettings={onOpenTaggingSettings} />}
            <DensityIsland value={density} preview={zoomPreview} onPreview={(v) => wall.current?.previewDensity(v)} onCommit={setDensity} />
          </div>
          {/* 多选的浮动操作条（#98）：选择面板把数量与批量操作放到这里。 */}
          <div className="selbar-host" ref={setBarHost} />
        </main>
        {inspectorContent && !hidden && (
          <aside ref={setInspectorElement} className="inspector" aria-label="详情" data-collapsed={!inspectorOpen} data-resizing={draggedWidth !== null} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
            <InspectorResizer width={panelWidth} onResize={(width, done) => {
              if (!done) { setDraggedWidth(width); return; }
              setDraggedWidth(null);
              onInspectorWidth(width);
            }} />
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
                workspace
                libraryId={selectionLibrary ?? libraryId}
                scope={scope}
                bar={barHost}
                selected={new Set(selectedCards.flatMap((card) =>
                  card.sources?.filter((source) => source.libraryId === selectionLibrary && !source.unavailable).map((source) => source.imageId) ?? []))}
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
        safe={safe}
        onTrash={(viewing.sources?.find((source) => source.libraryId === viewing.libraryId)?.deleted ?? scope.kind === "trash") ? undefined : () => { wallActions.edit([viewing], [{ kind: "delete" }], true); setViewing(null); }}
      />
    )}
    {wallDialogs}
    </>
  );
}

/** 详情面板的预览图与图片墙同为参考图来源：截在上面时读原始像素，而不是缩略图的屏幕像素。 */
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
 * Ctrl+= / Ctrl+- / Ctrl+0 按档位放大、缩小、复位界面缩放（#173）。
 */
export function App() {
  return <ToastProvider><MainWindow /></ToastProvider>;
}

function MainWindow() {
  useCaptureSources(() => [], -100);
  const toast = useToast();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** 设置打开时先显示的分页：状态栏打开通用，打标图标打开自动标签（#144）。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const openSettings = (tab: SettingsTab) => { setSettingsTab(tab); setShowSettings(true); };
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
  /** 标签外观（#160）：详情面板与查看器从上下文读取，设置一改立即生效。 */
  const [tagDisplay, setTagDisplay] = useState<TagDisplay>(DEFAULT_TAG_DISPLAY);
  const [inspectorWidth, setInspectorWidthState] = useState<number | undefined>(undefined);
  const acceptShellSettings = useCallback((view: ShellSettingsView) => {
    setShowApproxSource(view.showApproxSource);
    setTagDisplay(view.tagDisplay ?? DEFAULT_TAG_DISPLAY);
    setKeepSelectionOnSafe(view.keepSelectionOnSafeMode ?? false);
    setInspectorWidthState(view.inspectorWidth);
  }, []);
  /** 详情面板宽度先在界面上生效，再写进本设备设置；写不进时只是下次不记得。 */
  const changeInspectorWidth = useCallback((width: number) => {
    setInspectorWidthState(width);
    void setInspectorWidth(width).catch(() => {});
  }, []);
  /**
   * 界面缩放档位（#173）。WebView 由核心缩放，这里只记下档位给图片墙和设置用：
   * 显示的档位在核心保存并缩放之后才换；连按时从最后按下的那一档往下数。
   * 写入一次只发一个：上一个完成后若又按了别的档，再写最后按到的那一档，旧的写入不会盖过新的。
   */
  const [uiScalePercent, setUiScalePercent] = useState(initialUiScale);
  const uiScaleTarget = useRef(uiScalePercent);
  const uiScaleSaved = useRef(uiScalePercent);
  const uiScaleWriting = useRef(false);
  const acceptUiScale = useCallback((saved: number) => {
    uiScaleSaved.current = saved;
    uiScaleTarget.current = saved;
    setUiScalePercent(saved);
  }, []);
  const chooseUiScale = useCallback(async (percent: number) => {
    if (percent === uiScaleTarget.current) return;
    uiScaleTarget.current = percent;
    if (uiScaleWriting.current) return;
    uiScaleWriting.current = true;
    try {
      while (uiScaleTarget.current !== uiScaleSaved.current) {
        const wanted = uiScaleTarget.current;
        try {
          const saved = await setUiScale(wanted);
          uiScaleSaved.current = saved;
          if (uiScaleTarget.current === wanted) acceptUiScale(saved);
        } catch (e) {
          toast?.error(`无法更改界面缩放：${String(e)}`);
          acceptUiScale(await uiScale().catch(() => uiScaleSaved.current));
        }
      }
    } finally {
      uiScaleWriting.current = false;
    }
  }, [toast, acceptUiScale]);
  /**
   * 安全模式。读到设置之前按开启处理，不会先露出被封印的图。`safe` 是开关上显示的状态；
   * 查询资料库用 `lensSafe`：关闭时等后端确认才放开（#183，见 safeLens）。
   */
  const [safeState, setSafeState] = useState(INITIAL_SAFE_LENS);
  const safeStateRef = useRef(safeState);
  const applySafe = useCallback((action: SafeLensAction) => {
    safeStateRef.current = reduceSafeLens(safeStateRef.current, action);
    setSafeState(safeStateRef.current);
  }, []);
  const { shown: safe, lens: lensSafe } = safeState;
  const acceptSafe = useCallback((on: boolean) => applySafe({ kind: "external", on }), [applySafe]);
  /** 以后端保存的设置为准；读不到时按开启处理。 */
  const recheckSafe = useCallback(() => {
    safeMode().then(
      (on) => acceptSafe(on !== false),
      () => acceptSafe(true),
    );
  }, [acceptSafe]);
  const toggleSafe = useCallback(() => {
    // 不等后端：这一帧就开始遮蔽（或打开封印书）。
    applySafe({ kind: "toggle" });
    const next = safeStateRef.current.shown;
    safeTiming.toggled(next);
    setSafeMode(next).then(
      (on) => {
        safeTiming.mark("后端确认");
        applySafe({ kind: "settled", on });
        // 快速连点时返回可能乱序：与最后一次点击不一致就读一次设置校准。
        if (needsRecheck(safeStateRef.current, on)) recheckSafe();
      },
      (e) => {
        applySafe({ kind: "failed" });
        toast?.error(`无法切换安全模式：${String(e)}`);
        recheckSafe();
      },
    );
  }, [toast, applySafe, recheckSafe]);

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
      (on) => alive && acceptSafe(on !== false),
      () => {},
    );
    shellSettings().then(
      (view) => alive && view && acceptShellSettings(view),
      () => undefined,
    );
    uiScale().then(
      (saved) => { if (alive && typeof saved === "number" && !uiScaleWriting.current) acceptUiScale(saved); },
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
    workspaceStatus(lensSafe).then(accept, () => {});
    const stop = onWorkspaceChanged(accept);
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [lensSafe]);

  useEffect(() => {
    const stop = onSafeModeSetting(acceptSafe);
    return () => { void stop.then((stop) => stop()); };
  }, [acceptSafe]);

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

  // 界面缩放的固定按键；Ctrl+滚轮不在这里，它归图片墙的图片大小（#111）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = uiScaleStepForKey(e);
      if (!step) return;
      e.preventDefault();
      void chooseUiScale(stepUiScale(uiScaleTarget.current, step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseUiScale]);

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
    workspaceStatus(lensSafe).then((status) => setHasProviders(status.libraries.length > 0), () => {});
    setOpenError(null);
    setShowCreate(false);
  };

  const libraryControls = <LibraryPicker current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />;
  const empty = (!library && !hasProviders) || showCreate;
  const notices = <>
    <RuntimeNotice hidden={showSettings || viewerOpen} />
    {library && <div inert={viewerOpen}><LegacyNameMigrationNotice libraryId={library.id} safe={lensSafe} onOpen={() => setNameWizard(true)} /></div>}
    <UpdateBanner />
    <BackupReminder />
  </>;
  return (
    <UiScaleContext.Provider value={uiScalePercent / 100}>
    <TagDisplayContext.Provider value={tagDisplay}><SaveDestinationProvider safe={lensSafe}><div className="app app-shell">
      <div className="rail-slot" inert={viewerOpen}>
        <Rail section={section} paneOpen={paneOpen} safeMode={safe} onSafeMode={toggleSafe}
          onSection={(next) => { if (next === section) setPaneOpen((open) => !open); else { setSection(next); setPaneOpen(true); } }}
          onSettings={() => { if (showSettings) setShowSettings(false); else openSettings("general"); }} />
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
          safe={lensSafe}
          onSafeChanged={acceptSafe}
          showApproxSource={showApproxSource}
          keepSelectionOnSafe={keepSelectionOnSafe}
          inspectorWidth={inspectorWidth}
          onInspectorWidth={changeInspectorWidth}
          onViewerChange={setViewerOpen}
          notices={!empty && notices}
          onLibraryRemoved={(id) => { if (library?.id === id) changed(null); }}
          onOpenTaggingSettings={() => openSettings("tagging")}
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
          ) : showCreate ? (
            <CreateLibrary onCreated={changed} onBusyChange={setCreating} onBack={() => setShowCreate(false)} backLabel={library ? "返回图库" : "返回"} />
          ) : (
            <LibraryPicker layout="inline" current={library} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />
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
              initialTab={settingsTab}
              safe={safe}
              onSafeMode={toggleSafe}
              onOpenNameWizard={() => setNameWizard(true)}
              onChange={acceptShellSettings}
              uiScale={uiScalePercent}
              onUiScale={(percent) => void chooseUiScale(percent)}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <LegacyNameWizard open={nameWizard} onOpenChange={setNameWizard} />
      </div>
    </div></SaveDestinationProvider></TagDisplayContext.Provider>
    </UiScaleContext.Provider>
  );
}
