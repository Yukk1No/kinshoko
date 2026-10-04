import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TagDef, TagKey } from '../model';
import type { Condition, Term } from '../search';

type Props = {
  groups: { label: string; tags: TagDef[] }[];
  counts: Map<TagKey, number>;
  conditions: Condition[];
  onAdd: (term: Term, mode: 'and' | 'or', negate?: boolean) => void;
};

/** The "click a sorted tag" path of the representative scene (第一轮). Groups are 标签分组:
 * display only. Click adds AND, Ctrl+click joins the last condition as 任一, right-click excludes. */
export function TagGroupBar(p: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc, true); };
  }, [open]);
  const used = (key: TagKey) => p.conditions.find((c) => c.any.some((t) => t.kind === 'tag' && t.key === key));

  return <div className="groupbar" ref={bar} role="toolbar" aria-label="标签分组">
    {p.groups.map((g) => {
      const picked = g.tags.filter((t) => used(t.key)).length;
      return <div key={g.label} className="group">
        <button className={`group-btn${open === g.label ? ' is-open' : ''}${picked ? ' has-picked' : ''}`} aria-expanded={open === g.label}
          onClick={() => setOpen(open === g.label ? null : g.label)}>
          {g.label}{picked > 0 && <span className="badge tabular">{picked}</span>}<ChevronDown size={13} />
        </button>
        {open === g.label && <div className="group-pop" role="menu">
          <div className="chips">
            {g.tags.map((t) => {
              const c = used(t.key);
              const n = p.counts.get(t.key) ?? 0;
              return <button key={t.key} className={`chip pick${c ? (c.negate ? ' is-neg' : ' is-on') : ''}${!n && !c ? ' is-zero' : ''}`}
                onClick={(e) => p.onAdd({ kind: 'tag', key: t.key }, e.ctrlKey || e.metaKey ? 'or' : 'and')}
                onContextMenu={(e) => { e.preventDefault(); p.onAdd({ kind: 'tag', key: t.key }, 'and', true); }}>
                {t.name}<span className="count tabular">{n}</span>
              </button>;
            })}
          </div>
          <p className="pop-hint">数字是当前结果中的张数 · 点击：同时满足 · Ctrl＋点击：与上一个条件任一 · 右键：排除</p>
        </div>}
      </div>;
    })}
  </div>;
}
