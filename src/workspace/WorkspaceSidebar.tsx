import { PanelLeftClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { CaptureHistoryPanel } from "../desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "../desktop/ReferenceGroupsPanel";
import { WorkspacePane } from "../library/WorkspacePane";
import { useFloatEscape } from "../shell/paneFit";
import type { Section } from "../shell/Rail";
import { Tip } from "../ui/Tip";

/** 工作区左栏：文件夹（图库与查找范围）、参考组或截图历史。 */
export function WorkspaceSidebar({
  section, paneOpen, floating, paneRef, onPaneToggle, libraryControls, status, workspaceScope, safe, reloadKey, onError, recheck,
  onLibraryRemoved, onLibraryRestore, onScope, captureRequest, onCaptureRequestHandled,
}: {
  section: Section;
  paneOpen: boolean;
  /** 窄窗口里侧栏浮在图片墙上（paneFit）；Esc 收回。 */
  floating?: boolean;
  /** 侧栏元素，主窗口据此看它的宽度过渡，过渡中图片墙不逐帧重排。 */
  paneRef?: (element: HTMLElement | null) => void;
  onPaneToggle: () => void;
  libraryControls: ReactNode;
  status: WorkspaceStatus | null;
  workspaceScope: WorkspaceScope;
  safe: boolean;
  reloadKey: number;
  onError: (error: unknown) => void;
  recheck: () => void;
  onLibraryRemoved?: (libraryId: string) => void;
  onLibraryRestore?: (root: string) => Promise<void>;
  onScope: (next: WorkspaceScope) => void;
  captureRequest?: { id: string; stamp: number } | null;
  onCaptureRequestHandled?: () => void;
}) {
  useFloatEscape(!!floating, onPaneToggle);
  const libInPane = paneOpen && section === "browse";
  const { t } = useTranslation("workspace");
  const sectionName = section === "groups" ? t("pane.groups") : t("pane.captures");
  return (
    <aside
      ref={paneRef}
      className="sidebar-slot pane"
      data-collapsed={!paneOpen}
      data-float={floating || undefined}
      aria-label={section === "browse" ? t("pane.folders") : section === "groups" ? t("pane.groups") : t("pane.capturesLabel")}
      aria-hidden={!paneOpen}
      inert={!paneOpen}
    >
      <header className="pane-head" data-tauri-drag-region>
        {section === "browse" ? <div className="pane-library">{libInPane && libraryControls}</div>
          : <h1 className="pane-title">{sectionName}</h1>}
        <Tip label={t("collapsePane")} keys="Ctrl+B"><button type="button" className="k-icon-btn" aria-label={t("collapsePane")} onClick={onPaneToggle}><PanelLeftClose size={16} aria-hidden="true" /></button></Tip>
      </header>
      <div className="pane-body" hidden={section !== "browse"}>
      <WorkspacePane status={status} scope={workspaceScope} safeMode={safe}
        reloadKey={reloadKey} onError={onError} onRecheck={recheck} onRemoved={onLibraryRemoved} onRestore={onLibraryRestore} onScope={onScope}>
      </WorkspacePane>
      </div>
      {section === "groups" && <ReferenceGroupsPanel />}
      {section === "captures" && <CaptureHistoryPanel request={captureRequest} onRequestHandled={onCaptureRequestHandled} />}
    </aside>
  );
}
