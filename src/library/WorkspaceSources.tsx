import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { WorkspaceSourceEditor } from "./WorkspaceSourceEditor";
import { Segmented } from "../ui/Segmented";
import { useState } from "react";
import { Layers } from "lucide-react";
import { libraryPathHint } from "./library-path";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";

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
          title: [hint(source.libraryId), source.deleted ? "回收站" : null, source.unavailable ? "未连接" : null].filter(Boolean).join("，") || undefined }))} />
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
        <div className="selection-actions"><button type="button" className="k-btn is-sm" onClick={() => setEditing(source)}><span className="k-label">整理此来源</span></button>
        <button type="button" className="k-btn is-sm" onClick={() => { onClose(); onView({ ...card, libraryId: source.libraryId, imageId: source.imageId }); }}><span className="k-label">查看此来源</span></button></div>}
    </li>)}</ul>}
  </section>;
}
