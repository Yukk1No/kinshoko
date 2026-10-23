import { PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { CaptureHistoryPanel } from "../desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "../desktop/ReferenceGroupsPanel";
import { WorkspacePane } from "../library/WorkspacePane";
import type { Section } from "../shell/Rail";

/** 工作区左栏：文件夹（图库与查找范围）、参考组或截图历史。 */
export function WorkspaceSidebar({
  section, paneOpen, onPaneToggle, libraryControls, status, workspaceScope, safe, reloadKey, onError, recheck,
  onLibraryRemoved, onScope, libraryId, captureRequest, onCaptureRequestHandled,
}: {
  section: Section;
  paneOpen: boolean;
  onPaneToggle: () => void;
  libraryControls: ReactNode;
  status: WorkspaceStatus | null;
  workspaceScope: WorkspaceScope;
  safe: boolean;
  reloadKey: number;
  onError: (message: string) => void;
  recheck: () => void;
  onLibraryRemoved?: (libraryId: string) => void;
  onScope: (next: WorkspaceScope) => void;
  libraryId: string;
  captureRequest?: { id: string; stamp: number } | null;
  onCaptureRequestHandled?: () => void;
}) {
  const libInPane = paneOpen && section === "browse";
  const sectionName = section === "groups" ? "参考组" : "截图";
  return (
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
        reloadKey={reloadKey} onError={onError} onRecheck={recheck} onRemoved={onLibraryRemoved} onScope={onScope}>
      </WorkspacePane>
      </div>
      {section === "groups" && <ReferenceGroupsPanel libraryId={libraryId || undefined} />}
      {section === "captures" && <CaptureHistoryPanel libraryId={libraryId || undefined} request={captureRequest} onRequestHandled={onCaptureRequestHandled} />}
    </aside>
  );
}
