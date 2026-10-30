import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { useImportShortcut } from "./useImportShortcut";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { referenceCard } from "../desktop/openInKinshoko";
import { isCursorExpired } from "../ipc";
import { ImportMenu, type ImportControl } from "../library/ImportMenu";
import { SearchBox } from "../search/SearchBox";
import { TagGroupBar } from "../search/TagGroupBar";
import { fitPanes, isNarrow, usePaneFold, useWidth } from "../shell/paneFit";
import type { Section } from "../shell/Rail";
import { TaggingActivity } from "../TaggingActivity";
import { useToast } from "../ui/Toast";
import { WinCtrls } from "../ui/WinCtrls";
import { scopeKey, Wall, type WallHandle, type BrowserCard } from "../wall/Wall";
import { WallFloats } from "../wall/WallFloats";
import { WallMenu } from "../wall/WallMenu";
import { useWallActions } from "../wall/useWallActions";
import { Viewer } from "../viewer/Viewer";
import { TagGroupsDialog } from "./TagGroupsDialog";
import { useImportTasks } from "./useImportTasks";
import { useInvalidation } from "./useInvalidation";
import { useLibraryEvents } from "./useLibraryEvents";
import { useSearchTree } from "./useSearchTree";
import { useViewerStep } from "./useViewerStep";
import { WorkspaceInspector } from "./WorkspaceInspector";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { useWorkspaceInspector } from "./useWorkspaceInspector";
import { useWorkspaceStatus } from "./useWorkspaceStatus";

type WorkspaceProps = {
  library: LibraryInfo | null;
  captureRequest?:{id:string;stamp:number}|null;
  onCaptureRequestHandled?:()=>void;
  /** 钉图菜单“在 Kinshoko 中打开”的参考图（#106）：在查看器里打开。 */
  referenceRequest?: { libraryId: string; imageId: string; stamp: number } | null;
  section: Section;
  paneOpen: boolean;
  onPaneToggle: () => void;
  /** 窄窗口里自动收起、恢复侧栏，以及点开浮起的侧栏后收回。 */
  onPaneOpen: (open: boolean) => void;
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
export function LibraryWorkspace({
  library,
  captureRequest,
  onCaptureRequestHandled,
  referenceRequest,
  section,
  paneOpen,
  onPaneToggle,
  onPaneOpen,
  onOpenBrowse,
  libraryControls,
  hidden,
  safe,
  onSafeChanged,
  showApproxSource,
  keepSelectionOnSafe,
  inspectorWidth,
  onInspectorWidth,
  notices,
  onLibraryRemoved,
  onOpenTaggingSettings,
}: WorkspaceProps) {
  const keepSelectionOnSafeRef = useRef(keepSelectionOnSafe);
  keepSelectionOnSafeRef.current = keepSelectionOnSafe;
  const toast = useToast();
  const libraryId = library?.id ?? "";
  const [sources, setSources] = useState<WorkspaceCard | null>(null);
  const [loadedCards, setLoadedCards] = useState<BrowserCard[]>([]);
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>({ kind: "all" });
  const [reloadKey, setReloadKey] = useState(0);
  const [density, setDensity] = useState(240);
  /** 图片墙上 Ctrl+滚轮缩放中的预览值（#111），滑条跟着走。 */
  const [zoomPreview, setZoomPreview] = useState<number | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const wall = useRef<WallHandle>(null);
  const { imports, running, setRunning, report, setReport, started } = useImportTasks();
  const scope: BrowseScope = workspaceScope.kind === "library" ? workspaceScope.scope : { kind: "all" };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<BrowserCard | null>(null);
  /** 查看器打开时即进入框选（图片墙右键“框选局部钉住”或 F1）。 */
  const [viewCrop, setViewCrop] = useState(false);
  useEffect(() => { if (!viewing) setViewCrop(false); }, [viewing]);
  const importControl = useRef<ImportControl>(null);
  useImportShortcut(importControl, hidden);
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
  /**
   * 词表代次：词表、图片或安全模式变化时递增，重新解析条件、重新取得候选（标签可能改名、
   * 删除、新增了叫法，或在安全模式下被封印）。与后端 Search 缓存的修订号和安全模式对应。
   */
  const [vocabularyKey, setVocabularyKey] = useState(0);
  const { invalidate, observations } = useInvalidation({
    wall, loadedCards, setViewing, setSelected, setSources, setReloadKey, setVocabularyKey,
  });
  /**
   * 工作区读取期间修订变了（CursorExpired）：那次读到的结果已经过时，不是要用户处理的问题。
   * 像收到变更通知一样按新修订重读；变更停下后读取成功，不留下常驻横幅（#98）。
   * 同修订的变更通知会被略过，所以不能只等通知来补读。
   */
  const onError = useCallback((message: string) => {
    // 真实错误进轻提示（#98），一直留到画师按“知道了”；没有提示容器时退回就地横幅。
    if (!isCursorExpired(message)) { if (toast) toast.error(message); else setProblem(message); return; }
    invalidate({ kind: "cursorExpired" });
  }, [toast, invalidate]);
  const safeChanged = useRef(onSafeChanged);
  safeChanged.current = onSafeChanged;
  const viewerOpen = viewing !== null;
  // 修订变化后的选择修剪：等图片墙读完新的结果，然后只保留仍在的图。范围或安全模式变了时图片墙先清空（等它读完）；
  // 只是修订前进时图片墙保留旧卡片、原地换成新的一页（#142），这一页到达就修剪。
  useEffect(() => { invalidate({ kind: "pageAccepted", ready: resultCount !== null }); }, [loadedCards, resultCount]);
  const { viewingIndex, step } = useViewerStep({ viewing, setViewing, loadedCards, resultCount, wall });
  const { status, onWallStatus, recheck } = useWorkspaceStatus({ safe, onError, invalidate, observations });

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
    invalidate({ kind: "lensChanged", keepSelection: keepSelectionOnSafeRef.current });
  }, [safe]);
  useEffect(() => {
    imports.current.running = null;
    setRunning(null); setReport(null);
    invalidate({ kind: "activeLibraryChanged" });
  }, [libraryId]);
  useLibraryEvents({ libraryId, toast, imports, invalidate, safeChanged, keepSelectionOnSafeRef, setRunning, setReport });

  const { search, setSearch, tree, treeSafe, searching } = useSearchTree({ libraryId, safe, vocabularyKey, onError, setReloadKey });

  // 窄窗口里侧栏与详情面板按余量一起让位，主区不低于 300（#274）。
  const [appBody, setAppBody] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useWidth(appBody);
  const inspector = useWorkspaceInspector({
    selected, setSelected, loadedCards, workspaceScope, libraryId, sources, setSources, hidden, viewing, inspectorWidth,
    fitPanel: (width) => fitPanes(bodyWidth, width, paneOpen && !isNarrow(bodyWidth, width)).inspector,
  });
  const { selectionLibrary, eligible, inspected, inspectorContent, panelIds, inspectorOpen, inspectorMoving, draggedWidth, toggleInspector } = inspector;
  const panes = usePaneFold({ body: bodyWidth, inspector: inspectorOpen ? inspector.panelWidth : 0, paneOpen, onPaneOpen });

  // 图片墙的右键菜单与卡片快捷键（#102）。
  const { actions: wallActions, dialogs: wallDialogs } = useWallActions({
    safe, activeLibraryId: libraryId, onError,
    onOpen: (card) => { setViewCrop(false); setViewing(card); },
    onCrop: (card) => { setViewCrop(true); setViewing(card); },
    onInspect: (card) => setSources(card as WorkspaceCard),
    onChanged: () => invalidate({ kind: "contentEdited" }),
    removeCards: (cards) => {
      const putBack = wall.current?.remove(cards.map((card) => card.id));
      return (failed) => putBack?.(failed.map((card) => card.id));
    },
    onClearSelection: () => setSelected(new Set()),
    importFrom: (source) => importControl.current?.[source](),
    importClipboard: async () => { await importControl.current?.clipboard(); },
    onNotice: (message) => { toast?.show({ title: message, tone: "success" }); },
    selectAll: () => wall.current?.selectAll(),
    setDensity,
  });

  return (
    <>
    <div className="app-workspace workspace" hidden={hidden}>
      <div className="app-body" ref={setAppBody} style={{ "--sidebar-width": `${panes.sidebar}px` } as CSSProperties}>
        {panes.floating && <div className="pane-scrim" aria-hidden="true" onClick={() => onPaneOpen(false)} />}
        <WorkspaceSidebar section={section} paneOpen={paneOpen} floating={panes.floating} onPaneToggle={onPaneToggle} libraryControls={libraryControls}
          status={status} workspaceScope={workspaceScope} safe={safe} reloadKey={reloadKey} onError={onError} recheck={recheck}
          onLibraryRemoved={onLibraryRemoved} libraryId={libraryId} captureRequest={captureRequest} onCaptureRequestHandled={onCaptureRequestHandled}
          onScope={(next) => {
            // 查看中在左栏换范围：离开查看器，进入新的范围（#179）。
            setWorkspaceScope(next); invalidate({ kind: "scopeChanged" });
            if (panes.floating) onPaneOpen(false);
          }} />
        <main className="app-main main">
          <header className="topbar" data-tauri-drag-region>
            {!paneOpen && <button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label="展开侧栏" title="展开侧栏 Ctrl B"><PanelLeftOpen size={16} aria-hidden="true" /></button>}
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
              invalidate({ kind: "conditionsChanged" });
            }}
          />
          <div className="bar-meta">
            <span className="result-count tabular k-label" role="status" aria-label="查找结果">{resultCount === null ? "…" : resultCount + " 张"}</span>
          </div>
          <ImportMenu control={importControl} scope={workspaceScope} enabled={!hidden} libraryId={libraryId} libraryName={library?.name??""}
            running={running} finished={report} onStarted={started} onDismissReport={() => setReport(null)}
            onOpenTrash={(owner=libraryId) => {
              onOpenBrowse();
              setSearch({ conditions: [], exact: false });
              setWorkspaceScope({ kind: "library", libraryId:owner, scope: { kind: "trash" } });
              // 来源面板保持现状（与换左栏范围不同）。
              invalidate({ kind: "conditionsChanged" });
            }} />
          {!inspectorOpen && <WinCtrls />}
          </header>
          {notices}
          <div className="app-tagbar">
          <TagGroupBar workspace libraryId="workspace" safe={safe} generation={vocabularyKey} input={search}
            onChange={(next) => { setSearch(next); invalidate({ kind: "conditionsChanged" }); }} onError={onError} onEdit={() => setEditingGroups(true)} />
          </div>
          <TagGroupsDialog open={editingGroups} onOpenChange={setEditingGroups} safe={safe} generation={vocabularyKey}
            onBrowse={(globalIds) => {
              setSearch((prev) => ({
                ...prev,
                conditions: [{ any: globalIds.map((id) => ({ kind: "tag", id, dismissed: [] })), negate: false }],
              }));
              invalidate({ kind: "conditionsChanged" });
              setEditingGroups(false);
            }}
            onError={onError} />
          {problem && (
            <p className="app-problem" role="alert">
              {problem}
              <button type="button" onClick={() => setProblem(null)}>
                知道了
              </button>
            </p>
          )}
          {/* 图片墙所在的区域：查看器盖在这里（#179），左栏、顶栏与详情侧栏照常可用。 */}
          <div className="wall-host">
          <Wall
            ref={wall}
            density={density}
            onDensityPreview={setZoomPreview}
            onDensityCommit={(value) => { setZoomPreview(null); setDensity(value); }}
            onTotalChange={setResultCount}
            key={`${JSON.stringify(workspaceScope)}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
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
            viewerOpen={viewerOpen}
            menu={(target) => <WallMenu target={target} scope={scope} density={density} actions={wallActions} />}
            onCardCommand={(command, cards, point) => {
              if (command === "pin") wallActions.pin(cards, point);
              else if (command === "crop") wallActions.crop(cards[0]);
              else if (command === "copy") { if (cards.length === 1) wallActions.copy(cards[0]); else if (toast) toast.show({ title: "一次只能复制一张" }); else onError("一次只能复制一张"); }
              else wallActions.edit(cards, [{ kind: "delete" }], true);
            }}
            onPaste={wallActions.importClipboard}
          />
          {/* 图片墙右下角：打标图标（#144）在图片大小浮岛（#102 方案 C3，与 Ctrl+滚轮缩放成对）的左边。
              选了两张及以上时底部升起多选悬浮栏（#98，#180），右下角收成圆形按钮让位；查看器打开时悬浮栏隐藏。 */}
          <WallFloats
            tagging={(collapsed) => library && <TaggingActivity collapsed={collapsed} libraryId={library.id} registered={status?.libraries.map((entry) => entry.library.id)} onOpenSettings={onOpenTaggingSettings} />}
            density={viewerOpen ? null : { value: density, preview: zoomPreview, onPreview: (v) => wall.current?.previewDensity(v), onCommit: setDensity }}
            bar={inspected === null && eligible && !hidden && !viewerOpen && panelIds.length > 1 && selectionLibrary !== null ? {
              libraryId: selectionLibrary, scope, ids: panelIds, onClear: () => setSelected(new Set()), reloadKey, onError, safeMode: safe,
            } : null}
          />
          {viewing && (
            <Viewer
              workspace
              libraryId={viewing.libraryId ?? libraryId}
              card={{ ...viewing, id: viewing.imageId ?? viewing.id }}
              onClose={() => setViewing(null)}
              reloadKey={reloadKey}
              position={viewingIndex < 0 ? undefined : { index: viewingIndex, total: Math.max(resultCount ?? 0, loadedCards.length) }}
              onStep={step}
              startCrop={viewCrop}
              inspectorOpen={inspectorOpen}
              onToggleInspector={toggleInspector}
              onTrash={(viewing.sources?.find((source) => source.libraryId === viewing.libraryId)?.deleted ?? scope.kind === "trash") ? undefined : () => { wallActions.edit([viewing], [{ kind: "delete" }], true); setViewing(null); }}
            />
          )}
          </div>
        </main>
        {inspectorContent && !hidden && (
          <WorkspaceInspector inspector={inspector} status={status} safe={safe} reloadKey={reloadKey} vocabularyKey={vocabularyKey}
            libraryId={libraryId} scope={scope} sources={sources} setSources={setSources} setSelected={setSelected} setViewing={setViewing}
            onEdited={() => invalidate({ kind: "contentEdited" })} onError={onError} onInspectorWidth={onInspectorWidth} />
        )}
      </div>
    </div>
    {wallDialogs}
    </>
  );
}
