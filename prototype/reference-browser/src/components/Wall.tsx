import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { EyeOff, ImageOff } from 'lucide-react';
import type { ReferenceImage } from '../model';
import { captureAnchor, captureFocal, masonry, neighbour, resolveAnchor, resolveFocal, visible, type Anchor, type Focal, type Layout } from '../layout';

export type WallHandle = {
  reveal: (id: string, focus?: boolean) => void;
  focusCurrent: () => void;
  /** Call before the result set changes: the next layout moves every card on screen from where it is now (#13 reflow feedback). */
  prepareReflow: (motion: { delay: number; duration: number; resize?: boolean }) => Map<string, DOMRect>;
  /** Screen rect of a mounted card, or null. */
  rectOf: (id: string) => DOMRect | null;
  viewportRect: () => DOMRect | null;
  /** Ids of mounted cards whose box intersects the visible part of the wall. */
  onScreen: () => string[];
  finishReflow: () => void;
  /** Lay out at the current width plus delta until released (null): the side pane moves, the cards glide once. */
  holdWidth: (delta: number | null) => void;
  /** While the size slider is dragged: zoom the laid-out wall around the viewport centre; null springs back. */
  previewDensity: (density: number | null) => void;
};
export type WallStats = { columns: number; mounted: number; total: number };

type Props = {
  images: ReferenceImage[];
  /** Changes when the result set is a new search; geometry changes keep the anchor instead. */
  resultKey: string;
  density: number;
  capTall: boolean;
  showTitles: boolean;
  square: boolean;
  isHidden: (image: ReferenceImage) => boolean;
  onOpen: (image: ReferenceImage) => void;
  onMenu: (image: ReferenceImage, x: number, y: number) => void;
  onKey: (image: ReferenceImage, event: React.KeyboardEvent) => boolean;
  onStats?: (stats: WallStats) => void;
  empty: React.ReactNode;
  inert?: boolean;
  /** Cards that a released ghost is still flying to: kept in place but not drawn until it lands. */
  arriving?: Set<string>;
};

const GAP = 8, PAD = 12, OVERSCAN = 700, TITLE = 26;
/** Above this many results a size change just jumps: the layout itself is the cost then. */
const RESIZE_ANIMATED_MAX = 3000;

type Reflow = {
  before: Map<string, DOMRect>; delay: number; duration: number;
  /** Size change: only cards on screen before or after move, and newly shown ones fade in. */
  resize?: boolean;
  /** The layout the rects belong to: the reflow plays once a different one commits. */
  layout: Layout | null; done?: Set<string>; passes?: number;
};

export const Wall = forwardRef<WallHandle, Props>(function Wall(p, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [held, setHeld] = useState<number | null>(null);
  const heldRef = useRef<number | null>(null);
  heldRef.current = held;
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const reflow = useRef<Reflow | null>(null);
  const settledTop = useRef<number | null>(null);
  const shown = useRef<Layout | null>(null);
  /** The spot a picture-size change zooms around; held through a slider drag until the artist scrolls. */
  const focal = useRef<Focal | null>(null);
  const zoomTo = useRef<Focal | null>(null);
  const cardEl = (id: string) => scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null;
  const ids = useMemo(() => p.images.map((i) => i.id), [p.images]);
  const titleH = p.showTitles ? TITLE : 0;
  const layoutWidth = held ?? width;
  const boxes = useMemo(() => masonry(p.images, {
    width: layoutWidth, target: p.density, gap: GAP, pad: PAD, capRatio: p.capTall ? 2.6 : null, extra: titleH, square: p.square,
  }), [p.images, layoutWidth, p.density, p.capTall, titleH, p.square]);

  // A size change is caught while rendering, before React commits the new boxes: cards are still where they
  // are on screen, mid-glide included, so each step of a slider drag retargets from there.
  const seenDensity = useRef(p.density);
  if (seenDensity.current !== p.density) {
    seenDensity.current = p.density;
    const el = scroller.current;
    if (el && shown.current) zoomTo.current = focal.current = captureFocal(shown.current, ids, el.scrollTop, el.clientHeight, focal.current, focusId ?? undefined);
    const duration = el && !reflow.current && ids.length <= RESIZE_ANIMATED_MAX ? parseFloat(getComputedStyle(el).getPropertyValue('--t-slow')) || 0 : 0;
    if (el && duration > 0) {
      const before = new Map<string, DOMRect>();
      for (const card of el.querySelectorAll<HTMLElement>('.card[data-id]')) before.set(card.dataset.id!, card.getBoundingClientRect());
      reflow.current = { before, delay: 0, duration, resize: true, layout: shown.current };
    }
  }

  // Width comes from the scroller itself; a resize keeps the anchored picture in place.
  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      // While the side pane moves the layout width is held, so the wall does not relayout every frame.
      if (heldRef.current === null) setWidth(el.clientWidth);
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    sync();
    // Laid out before this frame paints, so a FLIP prepared for the resize starts from where the cards were.
    const ro = new ResizeObserver(() => flushSync(sync));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastResult = useRef(p.resultKey);
  useLayoutEffect(() => {
    const el = scroller.current;
    // The slider's preview zoom ends with the committed layout, animated or not (reduced motion, a large
    // library): a reflow reads its "before" rects with the zoom applied, so it is cleared before the FLIP.
    const canvasEl = canvasRef.current;
    if (canvasEl?.style.transform) {
      canvasEl.getAnimations().forEach((a) => a.cancel());
      canvasEl.style.transform = '';
    }
    if (!el || !width) return;
    if (lastResult.current !== p.resultKey) {
      // A new search starts at the top: the artist scans the new screen from the beginning.
      lastResult.current = p.resultKey;
      el.scrollTop = 0;
      anchor.current = null;
    } else {
      const top = zoomTo.current ? resolveFocal(boxes, ids, zoomTo.current) : resolveAnchor(boxes, ids, anchor.current);
      if (top !== null && Math.abs(el.scrollTop - top) > 0.5) {
        el.scrollTop = top;
        settledTop.current = el.scrollTop;
      }
      if (zoomTo.current) anchor.current = captureAnchor(boxes, ids, el.scrollTop, el.clientHeight, focusId ?? undefined);
    }
    zoomTo.current = null;
    shown.current = boxes;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes]);

  const onScroll = () => {
    const el = scroller.current!;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // The anchor's own scroll keeps the anchor: re-capturing after every relayout drifts to another picture.
    const own = settledTop.current !== null && Math.abs(el.scrollTop - settledTop.current) < 1;
    settledTop.current = null;
    if (own) return;
    anchor.current = captureAnchor(boxes, ids, el.scrollTop, el.clientHeight, focusId ?? undefined);
    focal.current = null;
  };

  const mounted = useMemo(() => visible(boxes, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN), [boxes, viewport]);
  const focusIndex = focusId ? ids.indexOf(focusId) : -1;
  const tabIndexId = focusIndex >= 0 ? focusId : mounted.length ? ids[mounted[0]] : null;
  const rendered = focusIndex >= 0 && !mounted.includes(focusIndex) ? [...mounted, focusIndex] : mounted;

  // FLIP: every card that was on screen glides from its old screen rect to its new box. Starting from the
  // measured rect (not the old box) keeps a reflow that interrupts another continuous. Runs on each commit
  // until the viewport has caught up with the anchored scroll, so cards that render mounts then move too.
  useLayoutEffect(() => {
    const r = reflow.current, el = scroller.current;
    if (!r || !el || r.layout === boxes) return;
    const done = new Set<string>(r.done);
    // Measured against the canvas, so a wall whose left edge is moving (the side pane) still lines up.
    const canvas = canvasRef.current!.getBoundingClientRect(), top = el.scrollTop, bottom = top + el.clientHeight;
    const seen = (y: number, h: number) => y < bottom && y + h > top;
    const easing = r.resize ? 'cubic-bezier(0.2, 0.8, 0.2, 1)' : 'cubic-bezier(0.65, 0, 0.35, 1)';
    for (const card of el.querySelectorAll<HTMLElement>('.card[data-id]')) {
      const id = card.dataset.id!;
      const i = done.has(id) ? -1 : ids.indexOf(id);
      if (i < 0) continue;
      done.add(id);
      const b = boxes.boxes[i], before = r.before.get(id);
      // A fade-in keeps running through retargets: restarting it would flash the card.
      if (r.resize) card.getAnimations().forEach((a) => { if (a.id !== 'appear') a.cancel(); });
      if (!before) {
        if (r.resize && seen(b.y, b.h) && !card.getAnimations().length) {
          card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: r.duration, easing }).id = 'appear';
        }
        continue;
      }
      const fromX = before.left - canvas.left, fromY = before.top - canvas.top;
      if (r.resize && !seen(fromY, before.height) && !seen(b.y, b.h)) continue;
      // Size changes ride on the transform too (scale from the top-left corner): nothing relayouts per frame,
      // and the card is at scale 1 again, sharp, the moment the glide ends.
      const sx = before.width / b.w, sy = before.height / b.h;
      const scaled = Math.abs(sx - 1) > 0.002 || Math.abs(sy - 1) > 0.002;
      if (!scaled && Math.abs(fromX - b.x) < 0.5 && Math.abs(fromY - b.y) < 0.5) continue;
      const from = `translate(${fromX}px, ${fromY}px)`, to = `translate(${b.x}px, ${b.y}px)`;
      card.animate(scaled
        ? [{ transformOrigin: '0 0', transform: `${from} scale(${sx}, ${sy})` }, { transformOrigin: '0 0', transform: `${to} scale(1, 1)` }]
        : [{ transform: from }, { transform: to }],
      { duration: r.duration, delay: r.delay, easing, fill: 'backwards' });
    }
    r.done = done;
    if (viewport.top === top || (r.passes = (r.passes ?? 0) + 1) > 2) reflow.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered]);

  const { onStats } = p;
  useEffect(() => { onStats?.({ columns: boxes.columns, mounted: rendered.length, total: ids.length }); }, [onStats, boxes.columns, rendered.length, ids.length]);

  const reveal = useCallback((id: string, focus = true) => {
    const el = scroller.current;
    const i = ids.indexOf(id);
    if (!el || i < 0) return;
    const b = boxes.boxes[i];
    if (b.y < el.scrollTop + 4 || b.y + b.h > el.scrollTop + el.clientHeight - 4) {
      el.scrollTop = Math.max(0, b.y - Math.max(PAD, (el.clientHeight - b.h) / 3));
    }
    setFocusId(id);
    anchor.current = captureAnchor(boxes, ids, el.scrollTop, el.clientHeight, id);
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    if (focus) requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
  }, [boxes, ids]);

  useImperativeHandle(ref, () => ({
    reveal,
    prepareReflow: (motion) => {
      const before = new Map<string, DOMRect>();
      const cards = scroller.current?.querySelectorAll<HTMLElement>('.card[data-id]') ?? [];
      // Read every rect (mid-animation positions included) before cancelling any animation.
      for (const card of cards) before.set(card.dataset.id!, card.getBoundingClientRect());
      for (const card of cards) card.getAnimations().forEach((a) => a.cancel());
      reflow.current = { before, ...motion, layout: boxes };
      return before;
    },
    rectOf: (id) => cardEl(id)?.getBoundingClientRect() ?? null,
    viewportRect: () => scroller.current?.getBoundingClientRect() ?? null,
    onScreen: () => {
      const el = scroller.current;
      if (!el) return [];
      const top = el.scrollTop, bottom = top + el.clientHeight;
      return rendered.filter((i) => boxes.boxes[i].y < bottom && boxes.boxes[i].y + boxes.boxes[i].h > top).map((i) => ids[i]);
    },
    holdWidth: (delta) => {
      const el = scroller.current;
      if (!el) return;
      if (delta === null) { setHeld(null); setWidth(el.clientWidth); } else setHeld(el.clientWidth + delta);
    },
    previewDensity: (density) => {
      const el = scroller.current, canvas = canvasRef.current;
      if (!el || !canvas) return;
      canvas.getAnimations().forEach((a) => a.cancel());
      if (density === null || density === p.density) {
        // Back to the committed size: spring back from wherever the zoom is.
        const from = canvas.style.transform;
        canvas.style.transform = '';
        if (from && !reduced()) canvas.animate([{ transform: from }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
        return;
      }
      if (!canvas.style.transform) scroller.current?.querySelectorAll<HTMLElement>('.card[data-id]').forEach((c) => c.getAnimations().forEach((a) => a.finish()));
      canvas.style.transformOrigin = `${el.clientWidth / 2}px ${el.scrollTop + el.clientHeight / 2}px`;
      canvas.style.transform = `scale(${density / p.density})`;
    },
    finishReflow: () => scroller.current?.querySelectorAll<HTMLElement>('.card[data-id]').forEach((c) => c.getAnimations().forEach((a) => a.finish())),
    focusCurrent: () => {
      const id = tabIndexId;
      if (id) scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    },
  }), [reveal, tabIndexId, rendered, boxes, ids, p.density]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const image = p.images[index];
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (event.key in dirs) {
      event.preventDefault();
      reveal(ids[neighbour(boxes, index, dirs[event.key])]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      reveal(ids[event.key === 'Home' ? 0 : ids.length - 1]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      p.onOpen(image);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
      p.onMenu(image, r.left + 24, r.top + 24);
    } else if (p.onKey(image, event)) {
      event.preventDefault();
    }
  };

  return <div className="wall" ref={scroller} onScroll={onScroll} aria-label="参考图" inert={p.inert || undefined}>
    {!p.images.length && <div className="wall-empty">{p.empty}</div>}
    <div className="wall-canvas" ref={canvasRef} style={{ height: p.images.length ? boxes.height : 0 }} role="list">
      {rendered.map((index) => {
        const image = p.images[index];
        const b = boxes.boxes[index];
        const hidden = p.isHidden(image);
        return <button key={image.id} role="listitem" data-id={image.id}
          className={`card${focusId === image.id ? ' is-current' : ''}${p.arriving?.has(image.id) ? ' is-arriving' : ''}`}
          style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h }}
          tabIndex={image.id === tabIndexId ? 0 : -1}
          aria-label={`${hidden ? '安全模式已遮挡 · ' : ''}${image.title}，${image.w}×${image.h}`}
          onFocus={() => setFocusId(image.id)}
          onClick={() => { setFocusId(image.id); p.onOpen(image); }}
          onContextMenu={(e) => { e.preventDefault(); setFocusId(image.id); p.onMenu(image, e.clientX, e.clientY); }}
          onKeyDown={(e) => onKeyDown(e, index)}>
          <span className={`card-image${image.format === 'PNG' && image.id.startsWith('fixture-alpha') ? ' checker' : ''}`} style={{ height: b.h - titleH }}>
            <Thumb image={image} />
            {hidden && <span className="veil"><EyeOff size={18} /><span>安全模式</span></span>}
          </span>
          {titleH > 0 && <span className="card-title">{image.title}</span>}
        </button>;
      })}
    </div>
  </div>;
});

const reduced = () => getComputedStyle(document.documentElement).getPropertyValue('--t-slow').trim().startsWith('0');

function Thumb({ image }: { image: ReferenceImage }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="thumb-failed"><ImageOff size={18} /><span>无法读取</span></span>;
  return <img src={image.thumb} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} />;
}
