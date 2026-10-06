import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages } from 'lucide-react';
import type { TagDef } from '../model';

/** Marks a tagger name that has no translation yet (ADR-0003). The tip floats on the page, so a chip inside a
 * scrolling panel or the top bar does not clip it. */
export function Untranslated({ def }: { def?: TagDef }) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  if (!def?.untranslated) return null;
  const show = (el: Element) => {
    const r = el.getBoundingClientRect();
    const below = r.top < 48;
    setAt({ x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
  };
  return <span className="untranslated" role="img" aria-label="尚未翻译"
    onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setAt(null)}>
    <Languages size={12} strokeWidth={1.75} />
    {at && createPortal(<span className={`tip floating${at.below ? ' below' : ''}`} role="tooltip" style={{ left: at.x, top: at.y }}>
      尚未翻译 · 模型原名 <code>{def.external?.[0] ?? def.name}</code>
    </span>, document.body)}
  </span>;
}
