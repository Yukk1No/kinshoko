import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, X } from "lucide-react";
import { WinCtrls } from "../ui/WinCtrls";
import { InspectorResizer } from "../shell/InspectorResizer";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import { ImportMenu } from "../library/ImportMenu";
import { WorkspacePane, WorkspaceSources } from "../library/WorkspacePane";
import { CaptureHistoryPanel } from "../desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "../desktop/ReferenceGroupsPanel";
import { SelectionPanel } from "../library/SelectionPanel";
import { TagGroupsPane } from "../library/TagGroupsPane";
import { SearchBox } from "../search/SearchBox";
import { TagGroupBar } from "../search/TagGroupBar";
import type { Section } from "../shell/Rail";
import { Dialog } from "@base-ui/react/dialog";
import { TaggingActivity } from "../TaggingActivity";
import { scopeKey, Wall } from "../wall/Wall";
import { WallMenu } from "../wall/WallMenu";
import { useWallActions } from "../wall/useWallActions";
import { WallFloats } from "../wall/WallFloats";
import { Viewer } from "../viewer/Viewer";
import { useWorkspaceState } from "./useWorkspaceState";
import { useInspectorState } from "./useInspectorState";

export type WorkspaceProps = {
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
  const {
    toast, libraryId, status, sources, setSources, loadedCards, setLoadedCards, workspaceScope,
    setWorkspaceScope, reloadKey, setReloadKey, density, setDensity, zoomPreview, setZoomPreview,
    resultCount, setResultCount, wall, running, report, setReport, scope, selected, setSelected, viewing,
    setViewing, viewCrop, setViewCrop, importControl, editingGroups, setEditingGroups, problem, setProblem,
    search, setSearch, tree, treeSafe, vocabularyKey, setVocabularyKey, onError, viewerOpen, viewingIndex,
    step, onWallStatus, searching, recheck, started,
  } = useWorkspaceState({ library, captureRequest, referenceRequest, hidden, safe, onSafeChanged, keepSelectionOnSafe });
  const {
    selectionKey, selectionLibrary, eligible, inspected, inspectorContent, panelIds, inspectorOpen,
    setInspectorElement, inspectorMoving, draggedWidth, setDraggedWidth, panelWidth, closeInspector,
    toggleInspector,
  } = useInspectorState({ selected, setSelected, loadedCards, workspaceScope, libraryId, sources, setSources, hidden, viewing, inspectorWidth });

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
    <div className="app-workspace workspace" hidden={hidden}>
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
            <button type="button" className="k-icon-btn" aria-label="收起侧栏" title="收起侧栏 Ctrl B" onClick={onPaneToggle}><PanelLeftClose size={16} aria-hidden="true" /></button>
          </header>
          <div className="pane-body" hidden={section !== "browse"}>
          <WorkspacePane status={status} scope={workspaceScope} safeMode={safe}
            reloadKey={reloadKey} onError={onError} onRecheck={recheck} onRemoved={onLibraryRemoved} onScope={(next) => {
              // 查看中在左栏换范围：离开查看器，进入新的范围（#179）。
              setWorkspaceScope(next); setSelected(new Set()); setSources(null); setViewing(null);
            }}>
          </WorkspacePane>
          </div>
          {section === "groups" && <ReferenceGroupsPanel libraryId={libraryId || undefined} />}
          {section === "captures" && <CaptureHistoryPanel libraryId={libraryId || undefined} request={captureRequest} onRequestHandled={onCaptureRequestHandled} />}
        </aside>
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
              setSelected(new Set());
              setViewing(null);
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
              setViewing(null);
            }} />
          {!inspectorOpen && <WinCtrls />}
          </header>
          {notices}
          <div className="app-tagbar">
          <TagGroupBar workspace libraryId="workspace" safe={safe} generation={vocabularyKey} input={search}
            onChange={(next) => { setSearch(next); setSelected(new Set()); setViewing(null); }} onError={onError} onEdit={() => setEditingGroups(true)} />
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
                    setViewing(null);
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
          {/* 图片墙所在的区域：查看器盖在这里（#179），左栏、顶栏与详情侧栏照常可用。 */}
          <div className="wall-host">
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
          <aside ref={setInspectorElement} className="inspector" aria-label="详情" data-selection={inspected?.id ?? selectionKey} data-collapsed={!inspectorOpen} data-resizing={draggedWidth !== null} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
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
              {inspected ? <WorkspaceSources key={inspected.id} card={inspected} registrations={status?.libraries ?? []} safe={safe} reloadKey={reloadKey} onClose={() => { if (sources) setSources(null); else setSelected(new Set()); }} onView={setViewing}
                onChanged={() => { setReloadKey((k) => k + 1); setVocabularyKey((k) => k + 1); }} />
              : <SelectionPanel
                workspace
                libraryId={selectionLibrary ?? libraryId}
                scope={scope}
                inlineActions={false}
                selected={new Set(panelIds)}
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
    {wallDialogs}
    </>
  );
}
