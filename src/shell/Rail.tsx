import { useLayoutEffect, useRef, useState } from 'react';
// Adapted from bd8aea4:prototype/reference-browser/src/components/Rail.tsx.
// Keep the accepted rail structure; icons are local SVG so the formal app needs no new runtime dependency.
import type { ReactNode } from 'react';
function Icon({ children }: { children: ReactNode }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>;
}
const Images = () => <Icon><rect x="5" y="3" width="16" height="16" rx="2" /><path d="m5 14 5-5 11 9M2 7v14h14" /><circle cx="16" cy="7" r="1" /></Icon>;
const Layers = () => <Icon><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></Icon>;
const History = () => <Icon><path d="M3 11a9 9 0 1 1 2.5 7M3 4v7h7M12 7v5l3 2" /></Icon>;
const Settings = () => <Icon><circle cx="12" cy="12" r="3" /><path d="m9 3-1 3-3 1-2 3 2 3v4l3 1 2 3h4l2-3 3-1v-4l2-3-2-3-3-1-1-3z" /></Icon>;
import { SealBook } from '../SealBook';

export type Section = 'browse' | 'groups' | 'captures';
type Props = {
  section: Section;
  paneOpen: boolean;
  safeMode: boolean;
  onSection: (s: Section) => void;
  onSafeMode: () => void;
  onSettings: () => void;
};

const ITEMS: { id: Section; label: string; icon: typeof Images; key: string }[] = [
  { id: 'browse', label: '图片与文件夹', icon: Images, key: 'Ctrl+1' },
  { id: 'groups', label: '参考组', icon: Layers, key: 'Ctrl+2' },
  { id: 'captures', label: '截图历史', icon: History, key: 'Ctrl+3' },
];

/** The icon rail the brief asked for: names on hover and focus, the selection always visible,
 * an indicator that follows the selection (Axolotl's feedback, not its code). */
export function Rail(p: Props) {
  const nav = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>(`[data-section="${p.section}"]`);
    if (el) setIndicator({ top: el.offsetTop + 8, height: el.offsetHeight - 16 });
  }, [p.section]);
  return <nav className="rail" aria-label="主导航">
    <div className="brand" title="Kinshoko">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
        <path className="brand-mark" fillRule="evenodd" d="M12 6 H20 A2 2 0 0 1 22 8 V27 L16 22.5 L10 27 V8 A2 2 0 0 1 12 6 Z M14.8 15.75 A3 3 0 1 1 17.2 15.75 L18 19.5 H14 Z" />
      </svg>
    </div>
    <div className="rail-items" ref={nav}>
      {indicator && <span className="rail-indicator" style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }} aria-hidden="true" />}
      {ITEMS.map(({ id, label, icon: Icon, key }) => <button key={id} data-section={id}
        className={`rail-btn${p.section === id ? ' is-active' : ''}`} aria-current={p.section === id ? 'page' : undefined}
        aria-label={label} aria-expanded={p.section === id ? p.paneOpen : undefined} aria-pressed={p.section === id && p.paneOpen} type="button" onClick={() => p.onSection(id)}>
        <Icon />
        <span className="tip" role="tooltip">{label}<kbd>{key}</kbd></span>
      </button>)}
    </div>
    <div className="rail-foot">
      <SealBook on={p.safeMode} onToggle={p.onSafeMode} />
      <button className="rail-btn" aria-label="设置" onClick={p.onSettings}>
        <Settings />
        <span className="tip" role="tooltip">程序设置</span>
      </button>
    </div>
  </nav>;
}
