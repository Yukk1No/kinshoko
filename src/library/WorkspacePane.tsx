import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";

/** Adapted from prototype/spec78-alignment/library-workspace.html's scope sidebar and source list. */
export function WorkspacePane({ status, scope, onScope }: {
  status: WorkspaceStatus | null; scope: WorkspaceScope; onScope: (scope: WorkspaceScope) => void;
}) {
  return <nav className="workspace-scope" aria-label="查找范围">
    <button type="button" className="sidebar-item" aria-current={scope.kind === "all" ? "page" : undefined}
      onClick={() => onScope({ kind: "all" })}>全部资料库</button>
    {status?.libraries.map(({ library, unavailable }) => <div key={library.id} className="workspace-provider" data-library-id={library.id}>
      <button type="button" className="sidebar-item"
        aria-current={scope.kind === "library" && scope.libraryId === library.id ? "page" : undefined}
        onClick={() => onScope({ kind: "library", libraryId: library.id, scope: { kind: "all" } })}>
        <span className="sidebar-label">{library.name}</span>
        {unavailable && <span className="provider-state">暂时不可用</span>}
      </button>
      {unavailable && <p className="provider-problem" role="status">{unavailable}</p>}
    </div>)}
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
