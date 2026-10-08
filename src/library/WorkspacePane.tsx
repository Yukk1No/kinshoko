import { useEffect, useState } from "react";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { FolderNode } from "../bindings/FolderNode";
import { isCursorExpired, isLensChanged, workspaceDirectories } from "../ipc";
import { SidebarPane } from "./SidebarPane";
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

/** Adapted from prototype/spec78-alignment/folder-workspace.html: independent roots, paths and descendant switch. */
export function WorkspacePane({ status, scope, onScope, activeLibraryId, safeMode, reloadKey, onError }: {
  status: WorkspaceStatus | null; scope: WorkspaceScope; onScope: (scope: WorkspaceScope) => void;
  activeLibraryId: string; safeMode: boolean; reloadKey: number; onError: (message: string) => void;
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
  const range = scope.kind === "all" ? "全部资料库" : selected ? selected.registration.library.name + " / " +
    (selected.registration.unavailable ? "暂时不可用" : isFolder ? path?.join(" / ") ?? (forest ? "文件夹已失效" : "正在读取目录") : local?.kind === "trash" ? "回收站" : local?.kind === "unassigned" ? "未归类" : "全部图片") : forest ? "资料库已失效" : "正在读取资料库";
  return <nav className="workspace-scope" aria-label="查找范围">
    <div className="workspace-current-scope" role="status">范围：{range}</div>
    {isFolder && scope.kind === "library" && <label className="workspace-descendants">
      <input type="checkbox" checked={local.kind === "folderTree"} disabled={!path || Boolean(selected?.registration.unavailable)}
        onChange={(event) => { setDescendants(event.target.checked); onScope({ ...scope, scope: { kind: event.target.checked ? "folderTree" : "folder", id: local.id } }); }} />
      包含子文件夹
    </label>}
    <button type="button" className="sidebar-item" aria-current={scope.kind === "all" ? "page" : undefined}
      onClick={() => onScope({ kind: "all" })}>全部资料库</button>
    {providers.map(({ registration: { library, unavailable }, sidebar, unassigned, descendants: counts }) => {
      const expanded = !collapsed.has(library.id);
      const selectedRoot = scope.kind === "library" && scope.libraryId === library.id;
      return <section key={library.id} className="workspace-provider" data-library-id={library.id}>
        <div className="workspace-provider-root">
          <button type="button" className="workspace-expand" aria-label={`${expanded ? "收起" : "展开"}${library.name}：${library.root}`}
            aria-expanded={expanded} onClick={() => setCollapsed((previous) => {
              const next = new Set(previous); if (expanded) next.add(library.id); else next.delete(library.id); return next;
            })}>{expanded ? "−" : "+"}</button>
          <button type="button" className="sidebar-item" disabled={Boolean(unavailable) || !sidebar}
            aria-label={unavailable ? library.name + "（暂时不可用）" : `${library.name}（${sidebar?.all ?? "…"} 张）`}
            aria-current={selectedRoot && scope.scope.kind === "all" ? "page" : undefined}
            onClick={() => onScope({ kind: "library", libraryId: library.id, scope: { kind: "all" } })} title={library.root}>
            <span className="sidebar-label">{library.name}</span>
            {unavailable ? <span className="provider-state">暂时不可用</span> : <span className="sidebar-count">{sidebar?.all ?? "…"}</span>}
          </button>
        </div>
        <div className="provider-path" title={library.root}>{library.root}</div>
        {unavailable && <p className="provider-problem" role="status">{unavailable}</p>}
        {expanded && sidebar && <SidebarPane directory={sidebar} unassigned={unassigned} descendantCounts={counts} includeDescendants={descendants} embedded libraryName={library.name + " / " + library.root}
          libraryId={library.id} workspace safeMode={safeMode} readOnly={library.id !== activeLibraryId}
          scopeSelected={selectedRoot} scope={selectedRoot ? scope.scope : { kind: "all" }}
          onScope={(next) => onScope({ kind: "library", libraryId: library.id, scope: next.kind === "folder" || next.kind === "folderTree" ? { kind: descendants ? "folderTree" : "folder", id: next.id } : next })}
          reloadKey={reloadKey} onError={onError} />}
      </section>;
    })}
  </nav>;
}

export function WorkspaceSources({ card, onClose, onView }: {
  card: WorkspaceCard; onClose: () => void; onView: (card: WorkspaceCard) => void;
}) {
  return <div className="workspace-sources-overlay" role="dialog" aria-modal="true" aria-label="资料库来源"
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <section className="workspace-sources">
      <header><h2>资料库来源</h2><button type="button" autoFocus onClick={onClose}>关闭来源</button></header>
      <p>同一文件 · 各份来源独立保留整理结果</p>
      <ul>{card.sources.map((source) => <li key={source.libraryId + "/" + source.imageId}>
        <strong>{source.libraryName}</strong>
        <span>{source.deleted ? "回收站" : source.matches ? "符合当前查找" : "不符合当前查找"}</span>
        <code>{source.imageId}</code>
        {source.unavailable ? <p role="status">{source.unavailable}</p> :
          <button type="button" onClick={() => { onClose(); onView({ ...card, libraryId: source.libraryId, imageId: source.imageId }); }}>查看此来源</button>}
      </li>)}</ul>
    </section>
  </div>;
}
