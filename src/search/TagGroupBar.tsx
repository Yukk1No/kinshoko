// Adapted from bd8aea4:prototype/reference-browser/src/components/TagGroupBar.tsx.
// Accepted popovers and condition gestures, backed by the formal library IPC and SearchInput.
import { useEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { SearchInput } from "../bindings/SearchInput";
import { isLensChanged, tagGroups, workspaceTagGroups } from "../ipc";
import { TagMarks, tagName } from "./SearchBox";
import { useUiLang } from "../i18n";

type Props = {
  workspace?: boolean;
  libraryId: string;
  safe: boolean;
  generation: number;
  input: SearchInput;
  onChange: (input: SearchInput) => void;
  onError: (error: unknown) => void;
  /** 标签栏右侧的“编辑分组”（#98）：打开分组编辑器。 */
  onEdit?: () => void;
};

export function TagGroupBar(p: Props) {
  const [found, setFound] = useState<{ key: string; groups: TagGroupView[] }>({ key: "", groups: [] });
  const lang = useUiLang();
  const key = JSON.stringify([p.libraryId, p.safe, p.generation, p.workspace, lang]);
  const current = useRef(key); current.current = key;
  const groups = found.key === key ? found.groups : [];
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (p.workspace ? workspaceTagGroups(p.libraryId, lang, p.safe) : tagGroups(p.libraryId, lang)).then(
      (next) => { if (alive && current.current === key) setFound({ key, groups: next ?? [] }); },
      (error) => { if (alive && current.current === key && !isLensChanged(error)) p.onError(error); },
    );
    return () => { alive = false; };
  }, [key, p.libraryId, p.safe, p.onError, p.workspace, lang]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(null); } };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  const used = (id: string) => p.input.conditions.find((c) => c.any.some((t) => t.kind === "tag" && t.id === id));
  const without = (id: string) => p.input.conditions.flatMap((c) => {
    const any = c.any.filter((t) => t.kind !== "tag" || t.id !== id);
    return any.length ? [{ ...c, any }] : [];
  });
  const remove = (id: string) => p.onChange({ ...p.input, conditions: without(id) });
  const add = (id: string, mode: "and" | "or", negate = false) => {
    const conditions = without(id);
    const term = { kind: "tag" as const, id, dismissed: [] };
    const last = conditions.at(-1);
    if (mode === "or" && last && !last.negate) conditions[conditions.length - 1] = { ...last, any: [...last.any, term] };
    else conditions.push({ any: [term], negate });
    p.onChange({ ...p.input, conditions });
  };
  return <div className="groupbar" ref={bar} role="toolbar" aria-label="标签分组">
    {groups.map((g) => {
      const picked = g.tags.filter(({ tag }) => used(tag.id)).length;
      return <div key={g.id} className="group">
        <button type="button" className={`group-btn${open === g.id ? " is-open" : ""}${picked ? " has-picked" : ""}`} aria-expanded={open === g.id}
          onClick={() => setOpen(open === g.id ? null : g.id)}>
          <span className="k-label">{g.name}</span>{picked > 0 && <span className="badge tabular">{picked}</span>}<span aria-hidden>⌄</span>
        </button>
        {open === g.id && <div className="group-pop" role="group" aria-label={`${g.name}标签`}>
          <button type="button" className="group-any" aria-label={`按“${g.name}”任一标签查找`} disabled={!g.tags.length}
            onClick={() => {
              p.onChange({ ...p.input, conditions: [...p.input.conditions, { any: g.tags.map(({ tag }) => ({ kind: "tag", id: tag.id, dismissed: [] })), negate: false }] });
              setOpen(null);
            }}>任一成员</button>
          <div className="chips">
            {g.tags.map(({ tag, count }) => {
              const c = used(tag.id);
              return <button type="button" key={tag.id} className={`chip pick${c ? (c.negate ? " is-neg" : " is-on") : ""}${!count && !c ? " is-zero" : ""}`}
                aria-pressed={!!c}
                onClick={(e) => c ? remove(tag.id) : add(tag.id, e.ctrlKey || e.metaKey ? "or" : "and")}
                onContextMenu={(e) => { e.preventDefault(); if (c?.negate) remove(tag.id); else add(tag.id, "and", true); }}>
                <span className="k-label">{tagName(tag)}</span><TagMarks tag={tag} /><span className="count tabular k-label">{count}</span>
              </button>;
            })}
          </div>
          
        </div>}
      </div>;
    })}
    {!groups.length && <span className="groupbar-empty">建好分组后，可在这里点选标签。</span>}
    {p.onEdit && <button type="button" className="groupbar-edit" onClick={p.onEdit}><PenLine size={13} aria-hidden="true" /><span className="k-label">编辑分组</span></button>}
  </div>;
}
