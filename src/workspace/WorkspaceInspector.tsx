import { PanelRightClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Dispatch, SetStateAction } from "react";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { SelectionPanel } from "../library/SelectionPanel";
import { WorkspaceSources } from "../library/WorkspacePane";
import { InspectorResizer } from "../shell/InspectorResizer";
import { WinCtrls } from "../ui/WinCtrls";
import type { WorkspaceInspectorState } from "./useWorkspaceInspector";

/** 工作区右侧的详情面板：明确打开的来源整理，或当前选择的整理；没有可整理的内容时留空，宽度不变。收起时不读详情。 */
export function WorkspaceInspector({
  inspector, status, safe, reloadKey, vocabularyKey, setSelected,
  onError, onInspectorWidth,
}: {
  inspector: WorkspaceInspectorState;
  status: WorkspaceStatus | null;
  safe: boolean;
  reloadKey: number;
  vocabularyKey: number;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  onError: (error: unknown) => void;
  onInspectorWidth: (width: number) => void;
}) {
  const { t } = useTranslation("workspace");
  const {
    setInspectorElement, inspected, selectionKey, inspectorOpen, draggedWidth, setDraggedWidth, panelWidth, closeInspector, closeSources,
    selectionLibrary, eligible, panelIds,
  } = inspector;
  return (
      <aside ref={setInspectorElement} className="inspector" aria-label={t("inspector.label")} data-selection={inspected?.id ?? selectionKey} data-collapsed={!inspectorOpen} data-resizing={draggedWidth !== null} aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
        <InspectorResizer width={panelWidth} onResize={(width, done) => {
          if (!done) { setDraggedWidth(width); return; }
          setDraggedWidth(null);
          onInspectorWidth(width);
        }} />
        <header className="insp-head" data-tauri-drag-region>
          <button type="button" className="k-icon-btn" aria-label={t("inspector.collapse")} title={t("inspector.collapse")} onClick={closeInspector}><PanelRightClose size={16} aria-hidden="true" /></button>
          <span className="insp-title">{t("inspector.title")}</span>
          {inspectorOpen && <WinCtrls />}
        </header>
        <div className="insp-body">
          {!inspectorOpen ? null : inspected ? <WorkspaceSources key={inspected.id} card={inspected} registrations={status?.libraries ?? []} safe={safe} reloadKey={reloadKey} onClose={closeSources} />
          : eligible && panelIds.length > 0 && <SelectionPanel
            libraryId={selectionLibrary ?? ""}
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
