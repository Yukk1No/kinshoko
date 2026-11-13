import { PanelLeftClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CaptureHistoryPanel } from "../desktop/CaptureHistoryPanel";
import { ReferenceGroupsPanel } from "../desktop/ReferenceGroupsPanel";
import { CreateLibrary } from "../library/CreateLibrary";
import { LibraryPicker } from "../library/LibraryPicker";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import { Tip } from "../ui/Tip";
import { WinCtrls } from "../ui/WinCtrls";
import type { Section } from "./Rail";

type Props = {
  hasProviders: boolean | undefined;
  paneOpen: boolean;
  section: Section;
  setPaneOpen: (open: boolean) => void;
  captureRequest: { id: string; stamp: number } | null;
  collectionHandled: () => void;
  opened: boolean;
  createPage: boolean;
  changed: (added: LibraryInfo | null) => void;
  setCreating: (busy: boolean) => void;
  setShowCreate: (show: boolean) => void;
  creating: boolean;
};

/** 还没有图库（或在新建第一个图库）时的整页：原样从 App.tsx 移出。 */
export function EmptyWorkspace({ hasProviders, paneOpen, section, setPaneOpen, captureRequest, collectionHandled, opened, createPage, changed, setCreating, setShowCreate, creating }: Props) {
  const { t } = useTranslation("shell");
  return (
          <div className="app-empty-workspace">
            {!hasProviders && paneOpen && section !== "browse" && <aside className="pane empty-context" aria-label={section === "groups" ? t("emptyPane.groups") : t("emptyPane.capturesLabel")}>
              <header className="pane-head" data-tauri-drag-region><h2 className="pane-title">{section === "groups" ? t("emptyPane.groups") : t("emptyPane.captures")}</h2>
                <Tip label={t("emptyPane.collapse")} keys="Ctrl+B"><button type="button" className="k-icon-btn" aria-label={t("emptyPane.collapse")} onClick={() => setPaneOpen(false)}><PanelLeftClose size={16} aria-hidden="true" /></button></Tip></header>
              {section === "groups" ? <ReferenceGroupsPanel /> : <CaptureHistoryPanel request={captureRequest} onRequestHandled={collectionHandled} />}
            </aside>}
          <main className="app-main app-main-centered">
            <header className="topbar is-empty" data-tauri-drag-region><span className="k-grow" /><WinCtrls /></header>
            <div className="app-empty-body">
            {!opened ? (
              <p role="status">{t("opening")}</p>
            ) : createPage ? (
              <CreateLibrary onCreated={changed} onBusyChange={setCreating} onBack={() => setShowCreate(false)} backLabel={t("back")} />
            ) : (
              <LibraryPicker layout="inline" ready={opened} onChanged={changed} onCreate={() => setShowCreate(true)} blocked={creating} />
            )}
            </div>
          </main>
          </div>
  );
}
