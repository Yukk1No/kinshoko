import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, ImageOff } from 'lucide-react';
import type { ReferenceImage } from '../model';
import { captureAnchor, masonry, neighbour, resolveAnchor, visible, type Anchor } from '../layout';

export type WallHandle = { reveal: (id: string, focus?: boolean) => void; focusCurrent: () => void };
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
};

const GAP = 8, PAD = 12, OVERSCAN = 700, TITLE = 26;

export const Wall = forwardRef<WallHandle, Props>(function Wall(p, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const ids = useMemo(() => p.images.map((i) => i.id), [p.images]);
  const titleH = p.showTitles ? TITLE : 0;
  const boxes = useMemo(() => masonry(p.images, {
    width, target: p.density, gap: GAP, pad: PAD, capRatio: p.capTall ? 2.6 : null, extra: titleH, square: p.square,
  }), [p.images, width, p.density, p.capTall, titleH, p.square]);

  // Width comes from the scroller itself; a resize keeps the anchored picture in place.
  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      setWidth(el.clientWidth);
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastResult = useRef(p.resultKey);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !width) return;
    if (lastResult.current !== p.resultKey) {
      // A new search starts at the top: the artist scans the new screen from the beginning.
      lastResult.current = p.resultKey;
      el.scrollTop = 0;
      anchor.current = null;
    } else {
      const top = resolveAnchor(boxes, ids, anchor.current);
      if (top !== null && Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
    }
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes]);

  const onScroll = () => {
    const el = scroller.current!;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    anchor.current = captureAnchor(boxes, ids, el.scrollTop, el.clientHeight, focusId ?? undefined);
  };

  const mounted = useMemo(() => visible(boxes, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN), [boxes, viewport]);
  const focusIndex = focusId ? ids.indexOf(focusId) : -1;
  const tabIndexId = focusIndex >= 0 ? focusId : mounted.length ? ids[mounted[0]] : null;
  const rendered = focusIndex >= 0 && !mounted.includes(focusIndex) ? [...mounted, focusIndex] : mounted;

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
    focusCurrent: () => {
      const id = tabIndexId;
      if (id) scroller.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    },
  }), [reveal, tabIndexId]);

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
    <div className="wall-canvas" style={{ height: p.images.length ? boxes.height : 0 }} role="list">
      {rendered.map((index) => {
        const image = p.images[index];
        const b = boxes.boxes[index];
        const hidden = p.isHidden(image);
        return <button key={image.id} role="listitem" data-id={image.id}
          className={`card${focusId === image.id ? ' is-current' : ''}`}
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

function Thumb({ image }: { image: ReferenceImage }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="thumb-failed"><ImageOff size={18} /><span>无法读取</span></span>;
  return <img src={image.thumb} alt="" draggable={false} decoding="async" onError={() => setFailed(true)} />;
}
