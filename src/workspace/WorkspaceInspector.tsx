import { PanelRightClose } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { SelectionPanel } from "../library/SelectionPanel";
import { WorkspaceSources } from "../library/WorkspacePane";
import { InspectorResizer } from "../shell/InspectorResizer";
import { WinCtrls } from "../ui/WinCtrls";
import type { BrowserCard } from "../wall/Wall";
import type { WorkspaceInspectorState } from "./useWorkspaceInspector";

/** 工作区右侧的详情面板：明确打开的来源整理，或当前选择的整理。 */
export function WorkspaceInspector({
  inspector, status, safe, reloadKey, vocabularyKey, libraryId, scope, sources, setSources, setSelected, setViewing,
  onEdited, onError, onInspectorWidth,
}: {
  inspector: WorkspaceInspectorState;
  status: WorkspaceStatus | null;
  safe: boolean;
  reloadKey: number;
  vocabularyKey: number;
  libraryId: string;
  scope: BrowseScope;
  sources: WorkspaceCard | null;
  setSources: Dispatch<SetStateAction<WorkspaceCard | null>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setViewing: Dispatch<SetStateAction<BrowserCard | null>>;
  /** 来源对话框改了图：重读并刷新词表。 */
  onEdited: () => void;
  onError: (message: string) => void;
  onInspectorWidth: (width: number) => void;
}) {
  const {
    setInspectorElement, inspected, selectionKey, inspectorOpen, draggedWidth, setDraggedWidth, panelWidth, closeInspector,
    selectionLibrary, panelIds,
  } = inspector;
  return (
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
            onChanged={onEdited} />
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
  );
}
