import { useLayoutEffect, useRef, useState } from 'react';
import { History, Images, Layers, Settings, Shield, ShieldOff } from 'lucide-react';

export type Section = 'browse' | 'groups' | 'captures';
type Props = {
  section: Section;
  paneOpen: boolean;
  safeMode: boolean;
  badges: Partial<Record<Section, number>>;
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
        aria-label={label} aria-expanded={p.section === id ? p.paneOpen : undefined} onClick={() => p.onSection(id)}>
        <Icon size={20} strokeWidth={1.75} />
        {!!p.badges[id] && <span className="rail-badge tabular">{p.badges[id]}</span>}
        <span className="tip" role="tooltip">{label}<kbd>{key}</kbd></span>
      </button>)}
    </div>
    <div className="rail-foot">
      <button className={`rail-btn safe${p.safeMode ? ' is-on' : ''}`} aria-pressed={p.safeMode} aria-label="安全模式" onClick={p.onSafeMode}>
        {p.safeMode ? <Shield size={20} strokeWidth={1.75} /> : <ShieldOff size={20} strokeWidth={1.75} />}
        <span className="tip" role="tooltip">安全模式{p.safeMode ? '：开' : '：关'}<kbd>Ctrl+Shift+S</kbd></span>
      </button>
      <button className="rail-btn" aria-label="设置" onClick={p.onSettings}>
        <Settings size={20} strokeWidth={1.75} />
        <span className="tip" role="tooltip">设置与样稿说明</span>
      </button>
    </div>
  </nav>;
}
