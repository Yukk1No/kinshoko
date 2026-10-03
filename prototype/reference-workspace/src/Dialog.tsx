import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, className = '', initialFocus }: { title: string; children: ReactNode; onClose: () => void; className?: string; initialFocus?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    if (initialFocus) dialog?.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

export function NameDialog({ title, label, initial = '', hint, onClose, onSave }: { title: string; label: string; initial?: string; hint?: string; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(initial);
  return <Modal title={title} onClose={onClose} initialFocus="input">
    <form className="name-form" onSubmit={event => { event.preventDefault(); if (name.trim()) onSave(name.trim()); }}>
      <label>{label}<input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={80} /></label>
      {hint && <p>{hint}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim()} type="submit">保存</button></div>
    </form>
  </Modal>;
}
