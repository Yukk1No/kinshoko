import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Minus, Search, X } from 'lucide-react';
import type { TagDef, TagKey } from '../model';
import { candidates, termLabel, type Condition, type Term } from '../search';
import { Untranslated } from './Untranslated';

export type SearchHandle = { focus: () => void };
type Props = {
  conditions: Condition[];
  dict: Record<TagKey, TagDef>;
  counts: Map<TagKey, number>;
  onAdd: (term: Term, mode: 'and' | 'or') => void;
  onToggleNegate: (id: string) => void;
  onRemove: (id: string, term?: number) => void;
  onClear: () => void;
};

/** One box for typed words and picked tags. Enter without a pick searches the words as typed,
 * which matches every namespace and alias (Q95); a pick narrows to that one tag (Q96). */
export const SearchBox = forwardRef<SearchHandle, Props>(function SearchBox(p, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));
  const list = useMemo(() => candidates(text, p.dict, p.counts, 8), [text, p.dict, p.counts]);
  const ambiguous = useMemo(() => {
    const q = text.trim();
    const exact = list.filter((c) => c.def.name === q || c.via === q);
    return new Set(exact.map((c) => c.def.ns)).size > 1 || exact.length > 1;
  }, [list, text]);

  const commit = (term: Term, mode: 'and' | 'or' = 'and') => {
    p.onAdd(term, mode);
    setText('');
    setActive(-1);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(list.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const mode = e.altKey ? 'or' : 'and';
      if (active >= 0 && list[active]) commit({ kind: 'tag', key: list[active].key }, mode);
      else if (text.trim()) commit({ kind: 'text', text: text.trim() }, mode);
    } else if (e.key === 'Backspace' && !text && p.conditions.length) {
      p.onRemove(p.conditions[p.conditions.length - 1].id);
    } else if (e.key === 'Escape') {
      if (text) { e.stopPropagation(); setText(''); } else input.current?.blur();
      setOpen(false);
    }
  };

  return <div className="search" onClick={() => input.current?.focus()}>
    <Search size={16} className="search-icon" />
    {p.conditions.map((c) => <span key={c.id} className={`cond${c.negate ? ' is-neg' : ''}`}>
      <button className="cond-neg" onClick={(e) => { e.stopPropagation(); p.onToggleNegate(c.id); }} title={c.negate ? '改回包含' : '改为排除'} aria-label={c.negate ? '改回包含' : '改为排除'}>
        {c.negate ? <Minus size={11} /> : <span className="dot" />}
      </button>
      {c.any.map((t, i) => <span key={i} className="cond-term">{i > 0 && <span className="or">或</span>}{termLabel(t, p.dict)}{t.kind === 'tag' && <Untranslated def={p.dict[t.key]} />}
        {c.any.length > 1 && <button className="cond-x-inner" onClick={(e) => { e.stopPropagation(); p.onRemove(c.id, i); }} aria-label="去掉这一项"><X size={10} /></button>}</span>)}
      <button className="cond-x" onClick={(e) => { e.stopPropagation(); p.onRemove(c.id); }} aria-label="移除条件"><X size={11} /></button>
    </span>)}
    <input ref={input} value={text} placeholder={p.conditions.length ? '再加一个条件…' : '输入发色、发型、作品、作者…（/）'}
      onChange={(e) => { setText(e.target.value); setActive(-1); setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
      onKeyDown={onKeyDown} aria-label="查找条件" role="combobox" aria-expanded={open && !!text} aria-autocomplete="list" />
    {p.conditions.length > 0 && <button className="search-clear" onClick={(e) => { e.stopPropagation(); p.onClear(); }} title="清除全部条件">清除</button>}
    {open && text.trim() && <ul className="suggest" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      <li role="option" aria-selected={active === -1} className={active === -1 ? 'is-active' : ''}>
        <button onClick={() => commit({ kind: 'text', text: text.trim() })}>
          <Search size={13} /> 查找“{text.trim()}”<span className="muted">{ambiguous ? ' · 不选则下面几项都匹配' : ' · 名称、别名、备注与来源链接'}</span><kbd>Enter</kbd>
        </button>
      </li>
      {list.map((c, i) => <li key={c.key} role="option" aria-selected={active === i} className={active === i ? 'is-active' : ''}>
        <button onClick={(e) => commit({ kind: 'tag', key: c.key }, e.altKey ? 'or' : 'and')}>
          <span className={`ns ns-${c.def.ns}`}>{c.def.ns}</span>
          <span className="name">{c.def.name}<Untranslated def={c.def} /></span>
          {c.via && <span className="muted">别名 {c.via}</span>}
          <span className="count tabular">{c.count}</span>
        </button>
        {p.conditions.length > 0 && <button className="or-add" title="与上一个条件任一满足（Alt+Enter）" onClick={() => commit({ kind: 'tag', key: c.key }, 'or')}>或</button>}
      </li>)}
    </ul>}
  </div>;
});
