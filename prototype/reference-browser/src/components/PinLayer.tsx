import { useEffect, useRef, useState } from 'react';
import { EyeOff, ImageOff, Lock } from 'lucide-react';
import { isTyping, type Capture, type Pin, type ReferenceImage, type Rotation } from '../model';

type Props = {
  pins: Pin[];
  edgeHidden: boolean;
  resolve: (pin: Pin) => { image?: ReferenceImage; capture?: Capture; missing?: boolean };
  isHidden: (image: ReferenceImage) => boolean;
  onChange: (id: string, patch: Partial<Pin>) => void;
  onFront: (id: string) => void;
  onMenu: (pin: Pin, x: number, y: number) => void;
  onClose: (id: string) => void;
};

const STRIP = 6;

export function pinSize(pin: Pin, w: number, h: number) {
  const sw = w * pin.scale, sh = h * pin.scale;
  return pin.rotate % 180 === 0 ? { w: sw, h: sh } : { w: sh, h: sw };
}

/** Where a pin rests while edge-hidden: slid to its nearest screen edge, a thin strip left showing (Q68). */
function edgeOffset(x: number, y: number, w: number, h: number) {
  const W = window.innerWidth, H = window.innerHeight;
  const d = [{ e: 'l', v: x + w }, { e: 'r', v: W - x }, { e: 't', v: y + h }, { e: 'b', v: H - y }].sort((a, b) => a.v - b.v)[0];
  if (d.e === 'l') return { dx: -(x + w - STRIP), dy: 0 };
  if (d.e === 'r') return { dx: W - STRIP - x, dy: 0 };
  if (d.e === 't') return { dx: 0, dy: -(y + h - STRIP) };
  return { dx: 0, dy: H - STRIP - y };
}

/** Stand-in for the desktop pins of #7. In the real app these are separate always-on-top windows
 * above the drawing software; here they float over this page. Interaction mirrors PR #21. */
export function PinLayer(p: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  // The active pin stands in for the focused pin window: the one just made or last touched.
  // Esc and the single-key operations act on it, as in Snipaste; touching anything else clears it.
  const [active, setActive] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const known = useRef(new Set(p.pins.map((x) => x.id)));

  useEffect(() => {
    const added = p.pins.filter((x) => !known.current.has(x.id));
    known.current = new Set(p.pins.map((x) => x.id));
    if (added.length) setActive(added[added.length - 1].id);
    else if (active && !known.current.has(active)) setActive(null);
  }, [p.pins]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const down = (e: PointerEvent) => { if (!(e.target instanceof Element && e.target.closest('.pin, .menu'))) setActive(null); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('.menu, dialog[open]')) return;
      const id = hover ?? (p.edgeHidden ? null : active);
      const pin = p.pins.find((x) => x.id === id);
      if (!pin) return;
      const k = e.key.toLowerCase();
      if (k === 'h') p.onChange(pin.id, { flipH: !pin.flipH });
      else if (k === 'v' && !e.ctrlKey) p.onChange(pin.id, { flipV: !pin.flipV });
      else if (k === 'r') p.onChange(pin.id, { rotate: ((pin.rotate + (e.shiftKey ? 270 : 90)) % 360) as Rotation });
      else if (k === 'l') p.onChange(pin.id, { locked: !pin.locked });
      else if (e.key === 'Escape' || e.key === 'Delete') { p.onClose(pin.id); setHover(null); setActive(null); }
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return <div className={`pin-layer${p.edgeHidden ? ' is-edge' : ''}`} aria-label="桌面钉图（模拟）">
    {p.pins.map((pin, z) => {
      const src = p.resolve(pin);
      const w = src.image?.w ?? src.capture?.w ?? 200, h = src.image?.h ?? src.capture?.h ?? 150;
      const crop = pin.source.kind === 'view' ? pin.source.view.crop : null;
      const cw = crop ? crop.w : w, ch = crop ? crop.h : h;
      const size = pinSize(pin, cw, ch);
      const off = p.edgeHidden && peek !== pin.id ? edgeOffset(pin.x, pin.y, size.w, size.h) : { dx: 0, dy: 0 };
      const veiled = src.image ? p.isHidden(src.image) : false;
      const inner = { w: cw * pin.scale, h: ch * pin.scale };
      const transform = `translate(-50%, -50%) rotate(${pin.rotate}deg) scale(${pin.flipH ? -1 : 1}, ${pin.flipV ? -1 : 1})`;
      return <div key={pin.id} className={`pin${pin.locked ? ' is-locked' : ''}${hover === pin.id || active === pin.id ? ' is-hover' : ''}`}
        style={{ left: pin.x, top: pin.y, width: size.w, height: size.h, zIndex: z + 1, transform: `translate(${off.dx}px, ${off.dy}px)` }}
        onPointerEnter={() => { setHover(pin.id); if (p.edgeHidden) setPeek(pin.id); }}
        onPointerLeave={() => { setHover((h0) => (h0 === pin.id ? null : h0)); if (p.edgeHidden) setPeek(null); }}
        onPointerDown={(e) => {
          setActive(pin.id);
          if (e.button !== 0) return;
          p.onFront(pin.id);
          if (pin.locked) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { id: pin.id, dx: e.clientX - pin.x, dy: e.clientY - pin.y };
        }}
        onPointerMove={(e) => { const d = drag.current; if (d?.id === pin.id) p.onChange(pin.id, { x: e.clientX - d.dx, y: e.clientY - d.dy }); }}
        onPointerUp={() => { drag.current = null; }}
        onWheel={(e) => {
          e.stopPropagation();
          if (e.ctrlKey) { p.onChange(pin.id, { opacity: Math.min(1, Math.max(0.15, pin.opacity - Math.sign(e.deltaY) * 0.05)) }); return; }
          if (pin.locked) return;
          // Zoom around the pointer, as in PR #21.
          const f = Math.pow(1.0015, -e.deltaY);
          const scale = Math.min(8, Math.max(0.05, pin.scale * f));
          const k = scale / pin.scale;
          p.onChange(pin.id, { scale, x: e.clientX - (e.clientX - pin.x) * k, y: e.clientY - (e.clientY - pin.y) * k });
        }}
        onDoubleClick={() => {
          if (pin.locked) return;
          // Back to the reference's own pixels, keeping the centre.
          const k = 1 / pin.scale;
          const cx = pin.x + size.w / 2, cy = pin.y + size.h / 2;
          p.onChange(pin.id, { scale: 1, x: cx - (size.w * k) / 2, y: cy - (size.h * k) / 2 });
        }}
        onContextMenu={(e) => { e.preventDefault(); p.onMenu(pin, e.clientX, e.clientY); }}>
        <div className="pin-content" style={{ width: inner.w, height: inner.h, transform, opacity: pin.opacity }}>
          {src.missing ? <div className="pin-missing"><ImageOff size={18} /><span>原图缺失</span><small>成员、裁切与布局已保留</small></div>
            : <img src={src.image?.view ?? src.capture?.url} alt="" draggable={false} className={pin.scale >= 2 ? 'pixelated' : ''}
              style={{ width: w * pin.scale, height: h * pin.scale, transform: crop ? `translate(${-crop.x * pin.scale}px, ${-crop.y * pin.scale}px)` : undefined }} />}
          {veiled && <div className="veil"><EyeOff size={16} /><span>安全模式</span></div>}
        </div>
        {pin.locked && <span className="pin-lock" aria-label="已锁定"><Lock size={11} /></span>}
        {pin.source.kind === 'capture' && !src.capture?.collectedAs && <span className="pin-badge">截图</span>}
      </div>;
    })}
  </div>;
}
