import { type DragEvent, } from "react";
import { Name } from "../ui/Name";
import { ChevronDown, ChevronRight, MoreHorizontal, } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useTranslation } from "react-i18next";
import { Menu, MenuPopup } from "../ui/Menu";
import { WarnIcon } from "../ui/WarnIcon";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import { describeCommandError, } from "../ipc/commandError";
import { moveFolder, } from "../ipc";
import { DRAG_FOLDER, DRAG_FOLDER_LIBRARY, LAST, SidebarPane } from "./SidebarPane";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { LibraryMenuItems, } from "./WorkspacePaneRows";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { Tip } from "../ui/Tip";

// 侧栏里的一个图库区段（标题、右键菜单、目录树），原样从 WorkspacePane.tsx 移出。

type Props = {
  provider: WorkspaceDirectory;
  scope: WorkspaceScope;
  openIds: Set<string>;
  sprung: string | null;
  setSprung: (id: string | null) => void;
  toggle: (id: string, open: boolean) => void;
  creatingIn: string | null;
  setCreatingIn: (id: string | null) => void;
  headDrop: string | null;
  setHeadDrop: (id: string | null) => void;
  descendants: boolean;
  springHandlers: (id: string, closed: boolean) => { onDragEnter: (e: DragEvent) => void; onDragLeave: () => void };
  reveal: (libraryId: string) => void;
  remove: (registration: LibraryRegistration) => void;
  onScope: (scope: WorkspaceScope) => void;
  onRecheck?: () => void;
  onError: (error: unknown) => void;
};

export function ProviderSection({ provider, scope, openIds, sprung, setSprung, toggle, creatingIn, setCreatingIn, headDrop, setHeadDrop, descendants, springHandlers, reveal, remove, onScope, onRecheck, onError }: Props) {
  const { t } = useTranslation("library");
      const { registration: { library, unavailable: offline }, sidebar, unassigned, descendants: counts } = provider;
      const unavailable = offline ? describeCommandError(offline) : null;
      const available = !unavailable && Boolean(sidebar);
      const expanded = available && (openIds.has(library.id) || sprung === library.id);
      const selectedRoot = scope.kind === "library" && scope.libraryId === library.id;
      const parentForNew = selectedRoot && (scope.scope.kind === "folder" || scope.scope.kind === "folderTree") ? scope.scope.id : null;
      const libraryItems = <LibraryMenuItems provider={provider} onNewFolder={() => { toggle(library.id, true); setCreatingIn(library.id); }}
        onReveal={() => reveal(library.id)} onRecheck={onRecheck} onRemove={() => remove(provider.registration)} />;
      const dropFolderHere = (e: DragEvent) => {
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        const from = e.dataTransfer.getData(DRAG_FOLDER_LIBRARY);
        if (!folder || (from && from !== library.id)) return;
        void moveFolder(library.id, folder, null, LAST).catch((error) => onError(error));
      };
      return <section key={library.id} className="workspace-provider lib-group" data-library-id={library.id}
        data-offline={unavailable ? "true" : undefined} {...springHandlers(library.id, available && !expanded)}>
        <ContextMenu.Root>
        {/* 图库标题的右键菜单与 ⋯ 同一组菜单项；未连接时名称按钮禁用（不接收指针），右键落在这一行上。 */}
        <Tip label={unavailable ? `${library.root}\n${unavailable}` : undefined}>
        <ContextMenu.Trigger render={<div className="workspace-provider-root lib-head" />}>
          {available ? <button type="button" className="workspace-expand" aria-label={expanded ? t("scope.collapse", { name: library.name }) : t("scope.expand", { name: library.name })}
            aria-expanded={expanded} onClick={() => {
              if (sprung === library.id) setSprung(null);
              toggle(library.id, !expanded);
            }}>{expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button>
            : <span className="workspace-expand" aria-hidden="true" />}
          <Tip label={unavailable ? undefined : library.root} align="start"><button type="button" className={`sidebar-item lib-head-name${unavailable ? " is-off" : ""}`} disabled={!available}
            aria-label={unavailable ? t("scope.libraryOffline", { name: library.name }) : sidebar ? t("scope.libraryCount", { name: library.name, count: sidebar.all }) : t("scope.libraryCountLoading", { name: library.name })}
            aria-current={selectedRoot && scope.scope.kind === "all" ? "page" : undefined}
            data-drop={headDrop === library.id || undefined}
            onDragOver={(e) => { if (available && e.dataTransfer.types.includes(DRAG_FOLDER)) { e.preventDefault(); setHeadDrop(library.id); } }}
            onDragLeave={() => setHeadDrop(null)}
            onDrop={(e) => { e.preventDefault(); setHeadDrop(null); dropFolderHere(e); }}
            onClick={() => onScope({ kind: "library", libraryId: library.id, scope: { kind: "all" } })}>
            <Name className="sidebar-label k-label">{library.name}</Name>
            {unavailable ? <span className="lib-warn is-off" aria-hidden="true"><WarnIcon /></span> : <span className="sidebar-count k-label">{sidebar?.all ?? "…"}</span>}
          </button></Tip>
          {unavailable && onRecheck && <button type="button" className="offline-retry" onClick={onRecheck}><span className="k-label">{t("scope.reconnect")}</span></button>}
          <Menu.Root modal={false}>
            <Tip label={t("scope.libraryActionsTitle")}><Menu.Trigger className="k-icon-btn lib-more" aria-label={t("scope.libraryActions", { name: library.name })}>
              <MoreHorizontal size={14} aria-hidden="true" />
            </Menu.Trigger></Tip>
            <MenuPopup width={200} label={t("scope.libraryActions", { name: library.name })}>
              {libraryItems}
            </MenuPopup>
          </Menu.Root>
        </ContextMenu.Trigger>
        </Tip>
        <MenuPopup width={200} label={t("scope.libraryActions", { name: library.name })}>{libraryItems}</MenuPopup>
        </ContextMenu.Root>
        {expanded && sidebar && <SidebarPane directory={sidebar} unassigned={unassigned} descendantCounts={counts} includeDescendants={descendants}
          libraryName={library.name} libraryId={library.id}
          scopeSelected={selectedRoot} scope={selectedRoot ? scope.scope : { kind: "all" }}
          creating={creatingIn === library.id} parentForNew={parentForNew} onCreatingDone={() => setCreatingIn(null)}
          onScope={(next) => onScope({ kind: "library", libraryId: library.id, scope: next.kind === "folder" || next.kind === "folderTree" ? { kind: descendants ? "folderTree" : "folder", id: next.id } : next })}
          onError={onError} />}
      </section>;
}
