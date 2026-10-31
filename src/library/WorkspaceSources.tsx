import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("inspector", { keyPrefix: "sources" });
  const [editing, setEditing] = useState<WorkspaceSource | null>(null);
  const keyOf = (source: WorkspaceSource) => source.libraryId + "/" + source.imageId;
  const root = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) => root(id) ? libraryPathHint(root(id)!, registrations.map((r) => r.library.root)) : undefined;
  return <section className="workspace-sources" aria-label={t("label")}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <div className="insp-sec">
      <h4><Layers size={13} aria-hidden="true" />{card.sources.length > 1 ? t("count", { count: card.sources.length }) : t("single")}<span className="insp-h-hint">{t("separately")}</span></h4>
      <Segmented label={t("picker")} value={editing ? keyOf(editing) : null}
        onChange={(key) => { const next = card.sources.find((s) => keyOf(s) === key); if (next) setEditing(next); }}
        options={card.sources.map((source) => ({ value: keyOf(source), label: source.libraryName, disabled: !!source.unavailable,
          title: [hint(source.libraryId), source.deleted ? t("trash") : null, source.unavailable ? t("offline") : null].filter(Boolean).join(t("titleSeparator")) || undefined }))} />
    </div>
    {editing && <WorkspaceSourceEditor key={keyOf(editing)} card={card} source={editing}
      safe={safe} registrations={registrations} reloadKey={reloadKey} onSource={setEditing} onClose={onClose} onChanged={onChanged} />}
    {!editing && <ul className="workspace-source-list">{card.sources.map((source) => <li key={keyOf(source)} data-source-library-id={source.libraryId} title={keyOf(source)}>
      <div className="workspace-source-head">
        <strong>{source.libraryName}</strong>
        <span className="workspace-source-state">{source.deleted ? t("trash") : source.matches ? t("matches") : t("notMatches")}</span>
      </div>
      {root(source.libraryId) && <span className="workspace-source-path" title={root(source.libraryId)}>{hint(source.libraryId)}</span>}
      {source.unavailable ? <p className="insp-hint" role="status">{source.unavailable}</p> :
        <div className="selection-actions"><button type="button" className="k-btn is-sm" onClick={() => setEditing(source)}><span className="k-label">{t("organize")}</span></button>
        <button type="button" className="k-btn is-sm" onClick={() => { onClose(); onView({ ...card, libraryId: source.libraryId, imageId: source.imageId }); }}><span className="k-label">{t("view")}</span></button></div>}
    </li>)}</ul>}
  </section>;
}
