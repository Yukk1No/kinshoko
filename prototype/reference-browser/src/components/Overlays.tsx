import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = { label: string; hint?: string; onSelect?: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; slider?: { value: number; min: number; max: number; step: number; onChange: (v: number) => void } } | 'sep';

/** Context menu: most pin and picture operations live here, per the #7 feedback. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    ref.current!.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        const i = list.indexOf(document.activeElement as HTMLElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [onClose]);
  return <div className="menu" ref={ref} role="menu" style={{ left: pos.x, top: pos.y }}>
    {items.map((item, i) => item === 'sep' ? <hr key={i} /> : item.slider
      ? <label key={i} className="menu-slider"><span>{item.label}</span>
        <input type="range" min={item.slider.min} max={item.slider.max} step={item.slider.step} value={item.slider.value} onChange={(e) => item.slider!.onChange(Number(e.target.value))} />
        <span className="tabular">{item.hint}</span></label>
      : <button key={i} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} disabled={item.disabled}
        className={item.danger ? 'danger' : ''} onClick={() => { item.onSelect?.(); onClose(); }}>
        <span className="check-mark">{item.checked ? '✓' : ''}</span><span>{item.label}</span>{item.hint && <kbd>{item.hint}</kbd>}
      </button>)}
  </div>;
}

export function Dialog({ title, children, onClose, actions, wide }: { title: string; children: React.ReactNode; onClose: () => void; actions: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    const cancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', cancel);
    return () => { d.removeEventListener('cancel', cancel); d.close(); };
  }, [onClose]);
  return <dialog ref={ref} className={`dialog${wide ? ' wide' : ''}`} aria-label={title}>
    <h2>{title}</h2>
    <div className="dialog-body">{children}</div>
    <div className="dialog-actions">{actions}</div>
  </dialog>;
}

export type Toast = { id: number; text: string; action?: { label: string; run: () => void } };

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return <div className="toasts" role="status" aria-live="polite">
    {toasts.map((t) => <div key={t.id} className="toast">
      <span>{t.text}</span>
      {t.action && <button className="link" onClick={() => { t.action!.run(); onDismiss(t.id); }}>{t.action.label}</button>}
      <button className="toast-x" onClick={() => onDismiss(t.id)} aria-label="关闭">×</button>
    </div>)}
  </div>;
}
