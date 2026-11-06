import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeftOpen, PanelRight } from "lucide-react";
import { useImportShortcut } from "./useImportShortcut";
import { useInspectorShortcut } from "./useInspectorShortcut";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { referenceCard } from "../desktop/openInKinshoko";
import { errorText, isCursorExpired } from "../ipc";
import { ImportMenu, type ImportControl } from "../library/ImportMenu";
import { SearchBox } from "../search/SearchBox";
import { TagGroupBar } from "../search/TagGroupBar";
import { fitPanes, isNarrow, usePaneFold, useWidth } from "../shell/paneFit";
import { usePanelSlide } from "../shell/usePanelSlide";
import { TaggingActivity } from "../TaggingActivity";
import { useToast } from "../ui/Toast";
import { WinCtrls } from "../ui/WinCtrls";
import { scopeKey, Wall, type WallHandle, type BrowserCard } from "../wall/Wall";
import { WallFloats } from "../wall/WallFloats";
import { WallMenu } from "../wall/WallMenu";
import { WallEmptyAction } from "./WallEmptyAction";
import { useWallActions } from "../wall/useWallActions";
import { Viewer } from "../viewer/Viewer";
import { useViewerFlight } from "../viewer/ViewerFlight";
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
import type { WorkspaceProps } from "./workspaceProps";

/**
 * 同一工作区浏览所有已登记资料库。没有“窗口打开的资料库”（ADR-0008）：资料库只来自卡片、浏览范围
 * 或画师的明确选择，后端按需切换可写句柄不影响这里的任何状态。
 */
export function LibraryWorkspace({
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
  inspectorShown,
  onInspectorShown,
  onLibraryRemoved,
  onOpenTaggingSettings,
}: WorkspaceProps) {
  const { t } = useTranslation(["workspace", "viewer"]);
  const keepSelectionOnSafeRef = useRef(keepSelectionOnSafe);
  keepSelectionOnSafeRef.current = keepSelectionOnSafe;
  const toast = useToast();
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
  const wallHost = useRef<HTMLDivElement>(null);
  const flight = useViewerFlight({ viewing, safe, host: wallHost, instant: hidden || !!captureRequest });
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
      (card) => { if (!alive) return; setViewCrop(false); setViewing(card); },
      (e) => { if (alive) toast.error(t("openFailed", { error: String(e) })); },
    );
    return () => { alive = false; };
  }, [referenceRequest]);
  /**
   * 词表代次：词表、图片或安全模式变化时递增，重新解析条件、重新取得候选（标签可能改名、
   * 删除、新增了叫法，或在安全模式下被封印）。与后端 Search 缓存的修订号和安全模式对应。
   */
  const [vocabularyKey, setVocabularyKey] = useState(0);
  const { invalidate, observations } = useInvalidation({
    wall, loadedCards, setViewing: (next) => { flight.cut(); setViewing(next); }, setSelected, setSources, setReloadKey, setVocabularyKey,
  });
  /**
   * 工作区读取期间修订变了（CursorExpired）：那次读到的结果已经过时，不是要用户处理的问题。
   * 像收到变更通知一样按新修订重读；变更停下后读取成功，不留下常驻横幅（#98）。
   * 同修订的变更通知会被略过，所以不能只等通知来补读。
   */
  const onError = useCallback((error: unknown) => {
    // 真实错误进轻提示（#98），一直留到画师按“知道了”；没有提示容器时退回就地横幅。
    if (!isCursorExpired(error)) { toast.error(errorText(error)); return; }
    invalidate({ kind: "cursorExpired" });
  }, [toast, invalidate]);
  const safeChanged = useRef(onSafeChanged);
  safeChanged.current = onSafeChanged;
  const viewerOpen = viewing !== null;
  // 修订变化后的选择修剪：等图片墙读完新的结果，然后只保留仍在的图。范围或安全模式变了时图片墙先清空（等它读完）；
  // 只是修订前进时图片墙保留旧卡片、原地换成新的一页（#142），这一页到达就修剪。
  useEffect(() => { invalidate({ kind: "pageAccepted", ready: resultCount !== null }); }, [loadedCards, resultCount]);
  const { viewingIndex, step } = useViewerStep({ viewing, setViewing, loadedCards, resultCount, wall });
  /** 序号在飞回途中留着：顶栏淡出时不跳动。 */
  const viewerPosition = useRef<{ index: number; total: number } | undefined>(undefined);
  if (viewing) viewerPosition.current = viewingIndex < 0 ? undefined : { index: viewingIndex, total: Math.max(resultCount ?? 0, loadedCards.length) };
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
  useLibraryEvents({ toast, imports, invalidate, safeChanged, keepSelectionOnSafeRef, setRunning, setReport });

  const { search, setSearch, tree, treeSafe, searching } = useSearchTree({ safe, vocabularyKey, onError, setReloadKey });

  // 窄窗口里侧栏与详情面板按余量一起让位，主区不低于 300（#274）。
  const [appBody, setAppBody] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useWidth(appBody);
  const inspector = useWorkspaceInspector({
    selected, setSelected, loadedCards, workspaceScope, sources, setSources, hidden, viewing, inspectorWidth, inspectorShown, onInspectorShown,
    fitPanel: (width) => fitPanes(bodyWidth, width, paneOpen && !isNarrow(bodyWidth, width)).inspector,
  });
  const { selectionLibrary, selectedCards, inspected, panelIds, inspectorOpen, inspectorMoving, draggedWidth, toggleInspector, openSources } = inspector;
  useInspectorShortcut(toggleInspector, hidden || viewing !== null);
  const [sidebarElement, setSidebarElement] = useState<HTMLElement | null>(null);
  const panes = usePaneFold({ body: bodyWidth, inspector: inspectorOpen ? inspector.panelWidth : 0, paneOpen, onPaneOpen });
  // 侧栏开合时图片墙一开始就按终点宽度排，卡片随侧栏一起滑到位；浮在墙上的侧栏不占墙的宽度。
  // 窄窗口里详情面板会同时让位或收回，它的变化一并算进终点。
  const sidebarSlide = usePanelSlide(sidebarElement, panes.floating ? null : panes.sidebar,
    { element: inspector.inspectorElement, finalWidth: inspectorOpen ? inspector.shownWidth : 0 });

  // 图片墙的右键菜单与卡片快捷键（#102）。
  const { actions: wallActions, dialogs: wallDialogs } = useWallActions({
    safe, onError,
    onOpen: (card) => { setViewCrop(false); setViewing(card); },
    onCrop: (card) => { setViewCrop(true); setViewing(card); },
    onInspect: (card) => openSources(card as WorkspaceCard),
    onChanged: () => invalidate({ kind: "contentEdited" }),
    removeCards: (cards) => {
      const putBack = wall.current?.remove(cards.map((card) => card.id));
      return (failed) => putBack?.(failed.map((card) => card.id));
    },
    onClearSelection: () => setSelected(new Set()),
    importFrom: (source) => importControl.current?.[source](),
    importClipboard: async () => { await importControl.current?.clipboard(); },
    onNotice: (message) => { toast.show({ title: message, tone: "success" }); },
    selectAll: () => wall.current?.selectAll(),
    setDensity,
  });

  return (
    <>
    <div className="app-workspace workspace" hidden={hidden}>
      <div className="app-body" ref={setAppBody} data-viewer-flying={flight.dim || undefined} style={{ "--sidebar-width": `${panes.sidebar}px` } as CSSProperties}>
        {panes.floating && <div className="pane-scrim" aria-hidden="true" onClick={() => onPaneOpen(false)} />}
        <WorkspaceSidebar section={section} paneOpen={paneOpen} floating={panes.floating} paneRef={setSidebarElement} onPaneToggle={onPaneToggle} libraryControls={libraryControls}
          status={status} workspaceScope={workspaceScope} safe={safe} reloadKey={reloadKey} onError={onError} recheck={recheck}
          onLibraryRemoved={onLibraryRemoved} captureRequest={captureRequest} onCaptureRequestHandled={onCaptureRequestHandled}
          onScope={(next) => {
            // 查看中在左栏换范围：离开查看器，进入新的范围（#179）。
            setWorkspaceScope(next); invalidate({ kind: "scopeChanged" });
            if (panes.floating) onPaneOpen(false);
          }} />
        <main className="app-main main">
          <header className="topbar" data-tauri-drag-region>
            {!paneOpen && <button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label={t("expandPane")} title={t("expandPaneTitle")}><PanelLeftOpen size={16} aria-hidden="true" /></button>}
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
            <span className="result-count tabular k-label" role="status" aria-label={t("results")}>{resultCount === null ? "…" : t("resultCount", { count: resultCount })}</span>
          </div>
          <ImportMenu control={importControl} scope={workspaceScope} enabled={!hidden}
            running={running} finished={report} onStarted={started} onDismissReport={() => setReport(null)}
            onOpenTrash={(owner) => {
              onOpenBrowse();
              setSearch({ conditions: [], exact: false });
              setWorkspaceScope({ kind: "library", libraryId:owner, scope: { kind: "trash" } });
              // 来源面板保持现状（与换左栏范围不同）。
              invalidate({ kind: "conditionsChanged" });
            }}
            onShowDestination={(destination) => {
              onOpenBrowse();
              setSearch((prev) => ({ ...prev, conditions: [] }));
              setWorkspaceScope({ kind: "library", libraryId: destination.libraryId,
                // 没选文件夹时打开整个图库：Eagle 导入与合并的重复项会保留原有文件夹，“未归类”可能一张也看不到。
                scope: destination.folderId === null ? { kind: "all" } : { kind: "folder", id: destination.folderId } });
              invalidate({ kind: "conditionsChanged" });
            }} />
          {!inspectorOpen && <>
            <button type="button" className="k-icon-btn" aria-label={t("viewer:tools.showInspector")} title={t("viewer:tools.showInspector")} onClick={toggleInspector}><PanelRight size={16} aria-hidden="true" /></button>
            <WinCtrls />
          </>}
          </header>
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
          {/* 图片墙所在的区域：查看器盖在这里（#179），左栏、顶栏与详情侧栏照常可用。 */}
          <div className="wall-host" ref={wallHost}>
          <Wall
            ref={wall}
            density={density}
            onDensityPreview={setZoomPreview}
            onDensityCommit={(value) => { setZoomPreview(null); setDensity(value); }}
            onTotalChange={setResultCount}
            key={`${JSON.stringify(workspaceScope)}/${scopeKey(scope)}/${JSON.stringify(tree)}`}
            workspaceScope={workspaceScope}
            onInspectSources={openSources}
            onCardsChange={setLoadedCards}
            onWorkspaceStatus={onWallStatus}
            scope={scope}
            conditions={tree}
            reloadKey={reloadKey}
            safeMode={safe}
            holdReflow={inspectorMoving || draggedWidth !== null}
            settle={sidebarSlide}
            selected={selected}
            onSelectionChange={(next) => {
              // 来源按钮打开的整理只对那一张：画师改了选择，面板跟着选择走。
              setSelected(next);
              setSources(null);
            }}
            onOpenImage={(card) => { setViewCrop(false); setViewing(card); }}
            viewerOpen={viewerOpen}
            menu={(target) => <WallMenu target={target} scope={scope} density={density} actions={wallActions} inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} />}
            onCardCommand={(command, cards, point) => {
              if (command === "pin") wallActions.pin(cards, point);
              else if (command === "crop") wallActions.crop(cards[0]);
              else if (command === "copy") { if (cards.length === 1) wallActions.copy(cards[0]); else toast.show({ title: t("copyOneOnly") }); }
              else wallActions.edit(cards, [{ kind: "delete" }], true);
            }}
            onPaste={wallActions.importClipboard}
            emptyAction={(empty) => <WallEmptyAction searching={empty} scope={scope} importControl={importControl}
              onClearConditions={() => { setSearch((prev) => ({ ...prev, conditions: [] })); invalidate({ kind: "conditionsChanged" }); }} />}
          />
          {/* 图片墙右下角：打标图标（#144）在图片大小浮岛（#102 方案 C3，与 Ctrl+滚轮缩放成对）的左边。
              选了两张及以上时底部升起多选悬浮栏（#98，#180），右下角收成圆形按钮让位；查看器打开时悬浮栏隐藏。 */}
          <WallFloats
            tagging={(collapsed) => <TaggingActivity collapsed={collapsed} onOpenSettings={onOpenTaggingSettings} />}
            density={viewerOpen ? null : { value: density, preview: zoomPreview, onPreview: (v) => wall.current?.previewDensity(v), onCommit: setDensity }}
            bar={inspected !== null || hidden || viewerOpen ? null
              : selectionLibrary !== null ? (panelIds.length > 1 ? {
                libraryId: selectionLibrary, scope, ids: panelIds, onClear: () => setSelected(new Set()), reloadKey, onError, safeMode: safe,
              } : null)
              : selectedCards.length > 1 ? {
                libraryId: null, scope, ids: selectedCards.map((card) => card.id), onClear: () => setSelected(new Set()), reloadKey, onError, safeMode: safe,
                acrossLibraries: {
                  folderLibrary: new Set(selectedCards.map((card) => card.libraryId)).size === 1 ? selectedCards[0].libraryId ?? null : null,
                  edit: (edits, clear) => wallActions.edit(selectedCards, edits, clear),
                },
              } : null}
          />
          {flight.card && (
            <Viewer
              key={flight.session}
              flight={flight.attr}
              hideImage={flight.hideImage}
              onPlaced={flight.onPlaced}
              libraryId={flight.card.libraryId}
              card={{ ...flight.card, id: flight.card.imageId ?? flight.card.id }}
              onClose={() => setViewing(null)}
              onBack={() => { flight.back(); setViewing(null); }}
              reloadKey={reloadKey}
              position={viewerPosition.current}
              onStep={step}
              startCrop={viewCrop}
              inspectorOpen={inspectorOpen}
              onToggleInspector={toggleInspector}
              onTrash={!viewing || (viewing.sources?.find((source) => source.libraryId === viewing.libraryId)?.deleted ?? scope.kind === "trash") ? undefined : () => { wallActions.edit([viewing], [{ kind: "delete" }], true); setViewing(null); }}
            />
          )}
          {flight.flier}
          </div>
        </main>
        {!hidden && (
          <WorkspaceInspector inspector={inspector} status={status} safe={safe} reloadKey={reloadKey} vocabularyKey={vocabularyKey}
            setSelected={setSelected}
            onError={onError} onInspectorWidth={onInspectorWidth} />
        )}
      </div>
    </div>
    {wallDialogs}
    </>
  );
}
