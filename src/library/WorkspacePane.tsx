import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { WorkspaceSourceEditor } from "./WorkspaceSourceEditor";
import { Segmented } from "../ui/Segmented";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Images, Layers, RefreshCw, Trash2 } from "lucide-react";
import { FluidList, FluidRow } from "../ui/FluidList";
import { Switch } from "../ui/Switch";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { FolderNode } from "../bindings/FolderNode";
import { isCursorExpired, isLensChanged, workspaceDirectories } from "../ipc";
import { SidebarPane } from "./SidebarPane";
import { libraryPathHint } from "./library-path";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";

function folderPath(nodes: FolderNode[], id: string, parent: string[] = []): string[] | null {
  for (const node of nodes) {
    const path = [...parent, node.name];
    if (node.id === id) return path;
    const found = folderPath(node.children, id, path);
    if (found) return found;
  }
  return null;
}

/**
 * 侧栏（#98，design/ui-system/README.md 侧栏布局）：顶部固定“全部图片”；中间滚动每个图库一组目录，
 * 未连接的图库就地显示原因与“重新连接”，末尾是“含子文件夹”；底部固定 `foot`（自动打标）与当前图库的回收站。
 * Adapted from prototype/spec78-alignment/folder-workspace.html: independent roots, paths and descendant switch.
 */
export function WorkspacePane({ status, scope, onScope, activeLibraryId, safeMode, reloadKey, onError, onRecheck, foot, children }: {
  status: WorkspaceStatus | null; scope: WorkspaceScope; onScope: (scope: WorkspaceScope) => void;
  activeLibraryId: string; safeMode: boolean; reloadKey: number; onError: (message: string) => void;
  /** 重新检查未连接的图库（移动盘接回后）。 */
  onRecheck?: () => void;
  foot?: ReactNode;
  children?: ReactNode;
}) {
  const key = JSON.stringify([status?.revision, safeMode, reloadKey]);
  const [loaded, setLoaded] = useState<{ key: string; forest: WorkspaceDirectories } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [descendants, setDescendants] = useState(!(scope.kind === "library" && scope.scope.kind === "folder"));
  useEffect(() => {
    let alive = true;
    const load = async () => {
      for (let attempt = 0; alive; attempt++) {
        try {
          const forest = await workspaceDirectories(safeMode);
          if (alive) setLoaded({ key, forest });
          return;
        } catch (error) {
          if (!alive || isLensChanged(error)) return;
          if (isCursorExpired(error) && attempt < 3) continue;
          onError(String(error));
          return;
        }
      }
    };
    void load();
    return () => { alive = false; };
  }, [key, safeMode, onError]);
  // A changed safety/provider revision hides old controls before a new request can complete.
  const forest = loaded?.key === key ? loaded.forest : null;
  const providers = forest?.providers ?? status?.libraries.map((registration) => ({ registration, sidebar: null, unassigned: 0, descendants: {} })) ?? [];
  const selected = scope.kind === "library" ? providers.find((p) => p.registration.library.id === scope.libraryId) : undefined;
  const local = scope.kind === "library" ? scope.scope : null;
  const isFolder = local?.kind === "folder" || local?.kind === "folderTree";
  const path = isFolder && selected?.sidebar ? folderPath(selected.sidebar.folders, local.id) : null;
  const range = scope.kind === "all" ? "全部图库" : selected ? selected.registration.library.name + " / " +
    (selected.registration.unavailable ? "未连接" : isFolder ? path?.join(" / ") ?? (forest ? "文件夹已失效" : "正在读取目录") : local?.kind === "trash" ? "回收站" : local?.kind === "unassigned" ? "未归类" : "全部图片") : forest ? "图库已失效" : "正在读取图库";
  // 侧栏三段（design/ui-system/README.md）：回收站只在底部出现一次。平时是当前图库的；
  // 从某个图库的导入回执“去回收站”时，这一项跟随正在查看的那个图库。
  const viewingTrash = scope.kind === "library" && scope.scope.kind === "trash";
  const trashLibraryId = viewingTrash ? scope.libraryId : activeLibraryId;
  const active = providers.find((p) => p.registration.library.id === trashLibraryId);
  const activeTrash: WorkspaceScope = { kind: "library", libraryId: trashLibraryId, scope: { kind: "trash" } };
  const trashCurrent = viewingTrash;
  return <nav className="workspace-scope side-bands" aria-label="查找范围">
    <div className="workspace-current-scope sr-only" role="status">范围：{range}</div>
    <div className="side-top">
      <FluidList><FluidRow index={0}>
        <button type="button" className="sidebar-item k-row" aria-current={scope.kind === "all" ? "page" : undefined}
          onClick={() => onScope({ kind: "all" })}><span className="k-row-icon" aria-hidden="true"><Images size={15} /></span><span className="sidebar-label">全部图片</span></button>
      </FluidRow></FluidList>
    </div>
    <div className="side-scroll">
    {providers.map(({ registration: { library, unavailable }, sidebar, unassigned, descendants: counts }) => {
      const expanded = !collapsed.has(library.id);
      const selectedRoot = scope.kind === "library" && scope.libraryId === library.id;
      return <section key={library.id} className="workspace-provider" data-library-id={library.id}>
        <div className="workspace-provider-root lib-head">
          <button type="button" className="workspace-expand" aria-label={`${expanded ? "收起" : "展开"}${library.name}：${library.root}`}
            aria-expanded={expanded} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous); if (expanded) next.add(library.id); else next.delete(library.id); return next;
            })}>{expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button>
          <button type="button" className="sidebar-item lib-head-name" disabled={Boolean(unavailable) || !sidebar}
            aria-label={unavailable ? library.name + "（未连接）" : `${library.name}（${sidebar?.all ?? "…"} 张）`}
            aria-current={selectedRoot && scope.scope.kind === "all" ? "page" : undefined}
            onClick={() => onScope({ kind: "library", libraryId: library.id, scope: { kind: "all" } })} title={library.root}>
            <span className={`lib-dot${unavailable ? " is-off" : ""}`} aria-hidden="true" />
            <span className="sidebar-label">{library.name}</span>
            {unavailable ? <span className="provider-state">未连接</span> : <span className="sidebar-count">{sidebar?.all ?? "…"}</span>}
          </button>
        </div>
        <div className="provider-path" title={library.root}>{libraryPathHint(library.root, providers.map((p) => p.registration.library.root))}</div>
        {unavailable && <div className="offline-card provider-problem" role="status">
          <b>找不到这个图库</b>
          <span>{unavailable}</span>
          {onRecheck && <button type="button" className="offline-retry" onClick={onRecheck}><RefreshCw size={11} aria-hidden="true" />重新连接</button>}
        </div>}
        {expanded && sidebar && <SidebarPane directory={sidebar} unassigned={unassigned} descendantCounts={counts} includeDescendants={descendants} embedded libraryName={library.name + " / " + library.root}
          libraryId={library.id} workspace safeMode={safeMode} readOnly={library.id !== activeLibraryId} showTrash={false}
          scopeSelected={selectedRoot} scope={selectedRoot ? scope.scope : { kind: "all" }}
          onScope={(next) => onScope({ kind: "library", libraryId: library.id, scope: next.kind === "folder" || next.kind === "folderTree" ? { kind: descendants ? "folderTree" : "folder", id: next.id } : next })}
          reloadKey={reloadKey} onError={onError} />}
      </section>;
    })}
    <div className="sub-toggle workspace-descendants">
      <Switch size="sm" label="含子文件夹" checked={isFolder ? local.kind === "folderTree" : descendants}
        disabled={!isFolder || !path || Boolean(selected?.registration.unavailable)}
        onCheckedChange={(checked) => {
          if (!isFolder || scope.kind !== "library") return;
          setDescendants(checked); onScope({ ...scope, scope: { kind: checked ? "folderTree" : "folder", id: local.id } });
        }} />
      <span aria-hidden="true">含子文件夹</span>
    </div>
    {children}
    </div>
    <div className="side-foot">
      {foot}
      {trashLibraryId && <FluidList><FluidRow index={0}>
        <button type="button" className="sidebar-item k-row" aria-current={trashCurrent ? "page" : undefined}
          disabled={!active?.sidebar} aria-label={`回收站（${active?.sidebar?.trash ?? "…"} 张）`} onClick={() => onScope(activeTrash)}>
          <span className="k-row-icon" aria-hidden="true"><Trash2 size={15} /></span><span className="sidebar-label">回收站</span>
          <span className="sidebar-count">{active?.sidebar?.trash ?? ""}</span>
        </button>
      </FluidRow></FluidList>}
    </div>
  </nav>;
}

/**
 * 详情面板里的多来源整理（#98）：同一文件在 N 个图库各自保留整理结果。先明确选一份来源，
 * 再用分段切换在来源之间换；标签、分级、文件夹与备注都只改所选的那一份。
 */
export function WorkspaceSources({ card, onClose, onView, safe = true, reloadKey = 0, onChanged, registrations = [] }: {
  card: WorkspaceCard; onClose: () => void; onView: (card: WorkspaceCard) => void;
  safe?: boolean; reloadKey?: number; onChanged?: () => void; registrations?: LibraryRegistration[];
}) {
  const [editing, setEditing] = useState<WorkspaceSource | null>(null);
  const keyOf = (source: WorkspaceSource) => source.libraryId + "/" + source.imageId;
  const root = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) => root(id) ? libraryPathHint(root(id)!, registrations.map((r) => r.library.root)) : undefined;
  return <section className="workspace-sources" aria-label="图库来源"
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <div className="insp-sec">
      <h4><Layers size={13} aria-hidden="true" />{card.sources.length > 1 ? `在 ${card.sources.length} 个图库` : "所在图库"}<span className="insp-h-hint">各自整理</span></h4>
      <Segmented label="当前操作的来源记录" value={editing ? keyOf(editing) : null}
        onChange={(key) => { const next = card.sources.find((s) => keyOf(s) === key); if (next) setEditing(next); }}
        options={card.sources.map((source) => ({ value: keyOf(source), label: source.libraryName, disabled: !!source.unavailable,
          title: [hint(source.libraryId), source.deleted ? "回收站" : null, source.unavailable ? "未连接" : null].filter(Boolean).join(" · ") || undefined }))} />
    </div>
    {editing && <WorkspaceSourceEditor key={keyOf(editing)} card={card} source={editing}
      safe={safe} registrations={registrations} reloadKey={reloadKey} onSource={setEditing} onClose={onClose} onChanged={onChanged} />}
    {!editing && <ul className="workspace-source-list">{card.sources.map((source) => <li key={keyOf(source)} data-source-library-id={source.libraryId} title={keyOf(source)}>
      <div className="workspace-source-head">
        <strong>{source.libraryName}</strong>
        <span className="workspace-source-state">{source.deleted ? "回收站" : source.matches ? "符合当前查找" : "不符合当前查找"}</span>
      </div>
      {root(source.libraryId) && <span className="workspace-source-path" title={root(source.libraryId)}>{hint(source.libraryId)}</span>}
      {source.unavailable ? <p className="insp-hint" role="status">{source.unavailable}</p> :
        <div className="selection-actions"><button type="button" className="k-btn is-sm" onClick={() => setEditing(source)}>整理此来源</button>
        <button type="button" className="k-btn is-sm" onClick={() => { onClose(); onView({ ...card, libraryId: source.libraryId, imageId: source.imageId }); }}>查看此来源</button></div>}
    </li>)}</ul>}
  </section>;
}
