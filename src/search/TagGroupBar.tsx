// Adapted from bd8aea4:prototype/reference-browser/src/components/TagGroupBar.tsx.
// Accepted popovers and condition gestures, backed by the formal library IPC and SearchInput.
import { useEffect, useRef, useState } from "react";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { SearchInput } from "../bindings/SearchInput";
import { tagGroups, workspaceTagGroups } from "../ipc";
import { TagMarks, UI_LANG, tagName } from "./SearchBox";

type Props = {
  workspace?: boolean;
  libraryId: string;
  safe: boolean;
  generation: number;
  input: SearchInput;
  onChange: (input: SearchInput) => void;
  onError: (message: string) => void;
};

export function TagGroupBar(p: Props) {
  const [groups, setGroups] = useState<TagGroupView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setGroups([]);
    (p.workspace ? workspaceTagGroups(p.libraryId, UI_LANG, p.safe) : tagGroups(p.libraryId, UI_LANG)).then(
      (next) => { if (alive) setGroups(next ?? []); },
      (error) => { if (alive) p.onError(String(error)); },
    );
    return () => { alive = false; };
  }, [p.libraryId, p.safe, p.generation, p.onError, p.workspace]);
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
          {g.name}{picked > 0 && <span className="badge tabular">{picked}</span>}<span aria-hidden>⌄</span>
        </button>
        {open === g.id && <div className="group-pop" role="group" aria-label={`${g.name}标签`}>
          <div className="chips">
            {g.tags.map(({ tag, count }) => {
              const c = used(tag.id);
              return <button type="button" key={tag.id} className={`chip pick${c ? (c.negate ? " is-neg" : " is-on") : ""}${!count && !c ? " is-zero" : ""}`}
                aria-pressed={!!c}
                onClick={(e) => c ? remove(tag.id) : add(tag.id, e.ctrlKey || e.metaKey ? "or" : "and")}
                onContextMenu={(e) => { e.preventDefault(); if (c?.negate) remove(tag.id); else add(tag.id, "and", true); }}>
                {tagName(tag)}<TagMarks tag={tag} /><span className="count tabular">{count}</span>
              </button>;
            })}
          </div>
          <p className="pop-hint">点击：同时满足，再点取消 · Ctrl＋点击：与上一个条件任一 · 右键：排除，再右键取消</p>
        </div>}
      </div>;
    })}
    {!groups.length && <span className="groupbar-empty">在侧栏整理标签分组后，可在这里点选标签。</span>}
  </div>;
}
