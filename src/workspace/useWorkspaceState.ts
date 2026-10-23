import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../ui/Toast";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { SearchInput } from "../bindings/SearchInput";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { isCursorExpired, isLensChanged, onLibraryEvent, onOrganizeWaiting, workspaceResolve, workspaceStatus, onWorkspaceChanged } from "../ipc";
import { referenceCard } from "../desktop/openInKinshoko";
import type { FinishedImport, RunningImport } from "../library/ImportBar";
import type { ImportControl } from "../library/ImportMenu";
import { UI_LANG } from "../search/SearchBox";
import type { WallHandle, BrowserCard } from "../wall/Wall";
import { safeTiming } from "../shell/safeTiming";
import type { WorkspaceProps } from "./LibraryWorkspace";

/**
 * 工作区的状态，以及它与资料库的同步：查找、浏览、选择、查看器与导入任务（原样取自 LibraryWorkspace）。
 */
export function useWorkspaceState({
  library, captureRequest, referenceRequest, hidden, safe, onSafeChanged, keepSelectionOnSafe,
}: Pick<WorkspaceProps, "library" | "captureRequest" | "referenceRequest" | "hidden" | "safe" | "onSafeChanged" | "keepSelectionOnSafe">) {
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
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>({ kind: "all" });
  const [reloadKey, setReloadKey] = useState(0);
  const [density, setDensity] = useState(240);
  /** 图片墙上 Ctrl+滚轮缩放中的预览值（#111），滑条跟着走。 */
  const [zoomPreview, setZoomPreview] = useState<number | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);
  /**
   * 修订变化后的选择修剪：等图片墙读完新的结果，然后只保留仍在的图。范围或安全模式变了时图片墙先清空（loading
   * 等它读完）；只是修订前进时图片墙保留旧卡片、原地换成新的一页（#142），这一页到达就修剪。
   */
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
  // 导入菜单里“图片”的快捷键 Ctrl O：与菜单项同一入口，导入进行中时由入口自己忽略。
  // 设置、分组编辑器等对话框或菜单开着时不响应，免得导入流程叠在它们上面。
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "o") return;
      if (e.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      importControl.current?.files();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);
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
  const viewerOpen = viewing !== null;
  useEffect(() => {
    if (prune.current === "reset" && resultCount === null) { prune.current = "loading"; return; }
    if (prune.current === "idle" || resultCount === null) return;
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
  const acceptStatus = useCallback((next: WorkspaceStatus, invalidateWall = false) => {
    statusObservations.current += 1;
    if (statusRevision.current === next.revision) return;
    if (invalidateWall) wall.current?.invalidate();
    const changed = statusRevision.current !== null;
    statusRevision.current = next.revision;
    setStatus(next);
    // 新快照先于通知到达时，同样撤销旧内容并刷新依赖；之后的同修订通知只消重。
    if (changed || invalidateWall) {
      setViewing(null);
      prune.current = "reset";
      setReloadKey((k) => k + 1);
      setVocabularyKey((k) => k + 1);
    }
  }, []);
  const onWallStatus = useCallback((next: WorkspaceStatus) => { acceptStatus(next); }, [acceptStatus]);

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

  const started = (taskId: string) => {
    const task = imports.current;
    // 结束事件可能先于命令返回到达：任务已有终态，迟到的响应不再复活它（#76）。
    if (task.finished.has(taskId)) return;
    task.running = taskId;
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => (r?.taskId === taskId ? r : { taskId, progress: { done: 0, total: 0 } }));
  };

  return {
    toast, libraryId, status, sources, setSources, loadedCards, setLoadedCards, workspaceScope,
    setWorkspaceScope, reloadKey, setReloadKey, density, setDensity, zoomPreview, setZoomPreview,
    resultCount, setResultCount, wall, running, report, setReport, scope, selected, setSelected, viewing,
    setViewing, viewCrop, setViewCrop, importControl, editingGroups, setEditingGroups, problem, setProblem,
    search, setSearch, tree, treeSafe, vocabularyKey, setVocabularyKey, onError, viewerOpen, viewingIndex,
    step, onWallStatus, searching, recheck, started,
  };
}
