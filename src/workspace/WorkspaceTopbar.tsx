import { useState, type ComponentProps, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeftOpen, PanelRight } from "lucide-react";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { ImportMenu, type ImportControl } from "../library/ImportMenu";
import { SearchBox } from "../search/SearchBox";
import { TagGroupBar } from "../search/TagGroupBar";
import { WinCtrls } from "../ui/WinCtrls";
import { Tip } from "../ui/Tip";
import { TagGroupsDialog } from "./TagGroupsDialog";
import { useSearchTree } from "./useSearchTree";

// 工作区顶栏、标签分组条与分组编辑对话框，原样从 LibraryWorkspace.tsx 移出。

type Search = ReturnType<typeof useSearchTree>;
type MenuProps = ComponentProps<typeof ImportMenu>;

type Props = {
  paneOpen: boolean;
  onPaneToggle: () => void;
  safe: boolean;
  vocabularyKey: number;
  search: Search["search"];
  searching: Search["searching"];
  treeSafe: Search["treeSafe"];
  tree: Search["tree"];
  changeSearch: Search["changeSearch"];
  showApproxSource: boolean;
  onError: (error: unknown) => void;
  resultCount: number | null;
  importControl: RefObject<ImportControl | null>;
  workspaceScope: WorkspaceScope;
  setWorkspaceScope: (scope: WorkspaceScope) => void;
  hidden: boolean;
  running: MenuProps["running"];
  report: MenuProps["finished"];
  started: MenuProps["onStarted"];
  setReport: (report: null) => void;
  onOpenBrowse: () => void;
  inspectorOpen: boolean;
  toggleInspector: () => void;
};

export function WorkspaceTopbar({ paneOpen, onPaneToggle, safe, vocabularyKey, search, searching, treeSafe, tree, changeSearch, showApproxSource, onError, resultCount, importControl, workspaceScope, setWorkspaceScope, hidden, running, report, started, setReport, onOpenBrowse, inspectorOpen, toggleInspector }: Props) {
  const { t } = useTranslation(["workspace", "viewer"]);
  const [editingGroups, setEditingGroups] = useState(false);
  return (
    <>
          <header className="topbar" data-tauri-drag-region>
            {!paneOpen && <Tip label={t("expandPane")} keys="Ctrl+B"><button type="button" className="k-icon-btn" onClick={onPaneToggle} aria-label={t("expandPane")}><PanelLeftOpen size={16} aria-hidden="true" /></button></Tip>}
          <SearchBox
            workspace
            libraryId="workspace"
            safe={safe}
            generation={vocabularyKey}
            input={search}
            tree={searching && treeSafe === safe ? tree : null}
            showSource={showApproxSource}
            onError={onError}
            onChange={changeSearch}
          />
          <div className="bar-meta">
            <span className="result-count tabular k-label" role="status" aria-label={t("results")}>{resultCount === null ? "…" : t("resultCount", { count: resultCount })}</span>
          </div>
          <ImportMenu control={importControl} scope={workspaceScope} enabled={!hidden}
            running={running} finished={report} onStarted={started} onDismissReport={() => setReport(null)}
            onOpenTrash={(owner) => {
              onOpenBrowse();
              setWorkspaceScope({ kind: "library", libraryId:owner, scope: { kind: "trash" } });
              // 来源面板保持现状（与换左栏范围不同）。
              changeSearch({ conditions: [], exact: false });
            }}
            onShowDestination={(destination) => {
              onOpenBrowse();
              setWorkspaceScope({ kind: "library", libraryId: destination.libraryId,
                // 没选文件夹时打开整个图库：Eagle 导入与合并的重复项会保留原有文件夹，“未归类”可能一张也看不到。
                scope: destination.folderId === null ? { kind: "all" } : { kind: "folder", id: destination.folderId } });
              changeSearch((prev) => ({ ...prev, conditions: [] }));
            }} />
          {!inspectorOpen && <>
            <Tip label={t("viewer:tools.showInspector")}><button type="button" className="k-icon-btn" aria-label={t("viewer:tools.showInspector")} onClick={toggleInspector}><PanelRight size={16} aria-hidden="true" /></button></Tip>
            <WinCtrls />
          </>}
          </header>
          <div className="app-tagbar">
          <TagGroupBar workspace libraryId="workspace" safe={safe} generation={vocabularyKey} input={search}
            onChange={changeSearch} onError={onError} onEdit={() => setEditingGroups(true)} />
          </div>
          <TagGroupsDialog open={editingGroups} onOpenChange={setEditingGroups} safe={safe} generation={vocabularyKey}
            onBrowse={(globalIds) => {
              changeSearch((prev) => ({
                ...prev,
                conditions: [{ any: globalIds.map((id) => ({ kind: "tag", id, dismissed: [] })), negate: false }],
              }));
              setEditingGroups(false);
            }}
            onError={onError} />
    </>
  );
}
