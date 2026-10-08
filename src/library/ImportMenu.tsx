import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ImportBar } from "./ImportBar";

/** Keep real import/drop/recovery operations mounted, with a compact browse-header entry. */
export function ImportMenu(p: ComponentProps<typeof ImportBar>) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const show = useCallback(() => setOpen(true), []);
  const active = p.running !== null;
  const finished = p.finished?.taskId;
  useEffect(() => { if (active || finished) show(); }, [active, finished, show]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", esc); };
  }, [open]);
  return <div className="import-menu" ref={menu}>
    <button type="button" aria-label="导入参考图" aria-expanded={open} title="导入文件、文件夹或 Eagle 资料库" onClick={() => setOpen(!open)}>导入{active ? "…" : ""}</button>
    <div className="import-popup" hidden={!open}>
      <header><strong>导入到 {p.libraryName}</strong><button type="button" aria-label="关闭导入操作" onClick={() => setOpen(false)}>×</button></header>
      <ImportBar {...p} onShowRequested={show} onDismissReport={() => { p.onDismissReport(); setOpen(false); }} />
      <p className="selection-hint">单击查看 · Ctrl／Shift 多选 · 空格选择</p>
    </div>
  </div>;
}
