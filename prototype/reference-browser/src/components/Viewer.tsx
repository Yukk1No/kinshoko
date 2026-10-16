import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Crop as CropIcon, EyeOff, Info, Pin, Square } from 'lucide-react';
import { isTyping, type Crop, type ReferenceImage } from '../model';

type Props = {
  image: ReferenceImage;
  position: string;
  hidden: boolean;
  infoOpen: boolean;
  info: React.ReactNode;
  onReveal: () => void;
  onToggleInfo: () => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  /** Pin a view at a screen rectangle with a display scale (screen px per original px). */
  onPin: (crop: Crop | null, rect: { x: number; y: number }, scale: number) => void;
};

type Ground = 'dark' | 'mid' | 'light' | 'checker';
const GROUNDS: { id: Ground; label: string }[] = [{ id: 'dark', label: '深灰' }, { id: 'mid', label: '中灰' }, { id: 'light', label: '浅灰' }, { id: 'checker', label: '棋盘' }];

export function Viewer(p: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  // scale: screen px per original px. "1" is the image at its own pixels; nothing is resampled for display beyond that.
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fit: true });
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number; done: boolean } | null>(null);
  const [ground, setGround] = useState<Ground>('dark');
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; mode: 'pan' | 'select' } | null>(null);
  const { image } = p;

  const fitView = useCallback(() => {
    const s = Math.min((size.w - 48) / image.w, (size.h - 48) / image.h, 1);
    setView({ scale: s, x: (size.w - image.w * s) / 2, y: (size.h - image.h * s) / 2, fit: true });
  }, [size, image]);

  useLayoutEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => { if (view.fit) fitView(); }, [size, fitView]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { fitView(); setSel(null); setSelecting(false); }, [image.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor: number, cx: number, cy: number) => setView((v) => {
    const scale = Math.min(32, Math.max(0.03, v.scale * factor));
    const k = scale / v.scale;
    return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fit: false };
  });
  const actual = () => setView((v) => {
    const cx = size.w / 2, cy = size.h / 2, k = 1 / v.scale;
    return { scale: 1, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, fit: false };
  });

  // Screen rectangle of the selection, clamped to the image: a box on the shown reference is a reference view (Q69).
  const cropOf = (s: NonNullable<typeof sel>): Crop | null => {
    const toImg = (x: number, y: number) => ({ x: (x - view.x) / view.scale, y: (y - view.y) / view.scale });
    const a = toImg(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1));
    const b = toImg(Math.max(s.x0, s.x1), Math.max(s.y0, s.y1));
    const x = Math.max(0, Math.round(a.x)), y = Math.max(0, Math.round(a.y));
    const w = Math.min(image.w, Math.round(b.x)) - x, h = Math.min(image.h, Math.round(b.y)) - y;
    return w >= 4 && h >= 4 ? { x, y, w, h } : null;
  };
  const crop = sel?.done ? cropOf(sel) : null;

  const pinCrop = () => {
    if (!crop) return;
    const r = stage.current!.getBoundingClientRect();
    p.onPin(crop, { x: r.left + view.x + crop.x * view.scale, y: r.top + view.y + crop.y * view.scale }, view.scale);
    setSel(null);
    setSelecting(false);
  };
  const pinWhole = () => {
    const r = stage.current!.getBoundingClientRect();
    p.onPin(null, { x: r.left + Math.max(0, view.x), y: r.top + Math.max(0, view.y) }, Math.min(view.scale, 520 / Math.max(image.w, image.h)));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (sel || selecting) { setSel(null); setSelecting(false); } else p.onClose();
      } else if (e.key === 'F1') { e.preventDefault(); setSelecting(true); setSel(null); }
      else if (e.key === 'Enter' && crop) { e.preventDefault(); pinCrop(); }
      else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey) { e.preventDefault(); if (crop) pinCrop(); else pinWhole(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); p.onStep(-1); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); p.onStep(1); }
      else if (e.key === '0') { e.preventDefault(); fitView(); }
      else if (e.key === '1') { e.preventDefault(); actual(); }
      else if (e.key === '+' || e.key === '=') zoomAt(1.25, size.w / 2, size.h / 2);
      else if (e.key === '-') zoomAt(0.8, size.w / 2, size.h / 2);
      else if (e.key === 'i' || e.key === 'I') p.onToggleInfo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || p.hidden) return;
    const pt = local(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (selecting || e.shiftKey) {
      drag.current = { ...pt, vx: 0, vy: 0, mode: 'select' };
      setSel({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, done: false });
    } else drag.current = { ...pt, vx: view.x, vy: view.y, mode: 'pan' };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pt = local(e);
    if (d.mode === 'pan') setView((v) => ({ ...v, x: d.vx + pt.x - d.x, y: d.vy + pt.y - d.y, fit: false }));
    else setSel((s) => s && { ...s, x1: pt.x, y1: pt.y });
  };
  const onPointerUp = () => {
    if (drag.current?.mode === 'select') setSel((s) => s && { ...s, done: true });
    drag.current = null;
  };

  const selBox = sel && { left: Math.min(sel.x0, sel.x1), top: Math.min(sel.y0, sel.y1), width: Math.abs(sel.x1 - sel.x0), height: Math.abs(sel.y1 - sel.y0) };
  const live = sel && !sel.done ? cropOf(sel) : crop;

  return <section className="viewer" aria-label={`查看 ${image.title}`}>
    <header className="viewer-bar">
      <button className="tool" onClick={p.onClose} title="返回图片墙（Esc）"><ArrowLeft size={17} /><span>返回</span></button>
      <span className="viewer-title" title={image.title}>{image.title}</span>
      <span className="muted tabular">{p.position}</span>
      <span className="spacer" />
      <button className="icon-tool" onClick={() => p.onStep(-1)} title="上一张（←）" aria-label="上一张"><ChevronLeft size={17} /></button>
      <button className="icon-tool" onClick={() => p.onStep(1)} title="下一张（→）" aria-label="下一张"><ChevronRight size={17} /></button>
      <span className="divider" />
      <button className={`tool${view.fit ? ' is-on' : ''}`} onClick={fitView} title="适应窗口（0）">适应</button>
      <button className={`tool${!view.fit && Math.abs(view.scale - 1) < 1e-6 ? ' is-on' : ''}`} onClick={actual} title="原图像素（1）">原图像素</button>
      <span className="zoom tabular" aria-live="polite">{Math.round(view.scale * 100)}%</span>
      <span className="divider" />
      <button className={`tool${selecting ? ' is-on' : ''}`} onClick={() => { setSelecting((s) => !s); setSel(null); }} title="框选局部（F1，或按住 Shift 拖动）"><CropIcon size={16} /><span>框选</span></button>
      <button className="tool" onClick={() => (crop ? pinCrop() : pinWhole())} title="钉到桌面（P）"><Pin size={16} /><span>{crop ? '钉住局部' : '钉住整图'}</span></button>
      <span className="divider" />
      <div className="ground-pick" role="radiogroup" aria-label="背景">
        {GROUNDS.map((g) => <button key={g.id} role="radio" aria-checked={ground === g.id} className={`swatch swatch-${g.id}`} title={`背景：${g.label}`} onClick={() => setGround(g.id)}><Square size={12} /></button>)}
      </div>
      <button className={`icon-tool${p.infoOpen ? ' is-on' : ''}`} onClick={p.onToggleInfo} title="信息（I）" aria-label="信息" aria-pressed={p.infoOpen}><Info size={17} /></button>
    </header>
    <div className="viewer-body">
      <div ref={stage} className={`stage ground-${ground}${selecting ? ' is-selecting' : ''}`}
        onWheel={(e) => { const pt = local(e); zoomAt(Math.pow(1.0015, -e.deltaY), pt.x, pt.y); }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={() => (view.fit ? actual() : fitView())}>
        <img className={`stage-image${view.scale >= 2 ? ' pixelated' : ''}${p.hidden ? ' is-veiled' : ''}`} src={image.view} alt={image.title} draggable={false}
          style={{ width: image.w * view.scale, height: image.h * view.scale, transform: `translate(${view.x}px, ${view.y}px)` }} />
        {p.hidden && <div className="stage-veil"><EyeOff size={22} /><p>安全模式下，这张图的内容分级为成人。</p><button className="primary" onClick={p.onReveal}>确认后显示</button></div>}
        {selBox && <div className="selection" style={selBox}>
          {live && <span className="selection-size tabular">{live.w} × {live.h} px（原图像素）</span>}
        </div>}
        {crop && selBox && <div className="selection-bar" style={{ left: selBox.left, top: selBox.top + selBox.height + 8 }}
          onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button className="primary" onClick={pinCrop}><Pin size={14} />钉住局部 <kbd>Enter</kbd></button>
          <button onClick={() => setSel(null)}>重选</button>
          <button onClick={() => { setSel(null); setSelecting(false); }}>取消 <kbd>Esc</kbd></button>
        </div>}
        {selecting && !sel && <p className="stage-hint">拖出要钉住的局部。框在图上得到参考视图，保留来源关系；Kinshoko 外的截图在正式版用同一个手势。</p>}
      </div>
      {p.infoOpen && p.info}
    </div>
  </section>;
}
