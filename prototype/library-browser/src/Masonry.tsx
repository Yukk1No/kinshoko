import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { Range } from '@tanstack/react-virtual';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { AlertCircle, ImageOff } from 'lucide-react';
import type { Picture } from './data';

export type Anchor = { id: string; index: number; offset: number; scroll: number; layout: string; pictures: Picture[] };
export type GridState = { columns: number; mounted: number; scroll: number; width: number };
export type GridHandle = {
  capture: () => Anchor | undefined;
  restore: (anchor?: Anchor, focusId?: string) => void;
  focus: (id: string) => void;
};
type Props = {
  pictures: Picture[]; selectedId: string | null; focusedId: string | null;
  density: number; capTall: boolean; initialAnchor?: Anchor;
  emptyKind: 'no-match' | 'empty-library' | 'removed-all'; onEmptyAction: () => void;
  onSelect: (picture: Picture) => void; onOpen: (picture: Picture) => void;
  onFocus: (id: string) => void; onState: (state: GridState) => void;
  onDelete: (id: string) => void;
};

// TanStack owns lane assignment, measurements and the virtual range; this component only connects cards.
const Masonry = forwardRef<GridHandle, Props>(function Masonry(props, ref) {
  const { pictures, selectedId, focusedId, density, capTall, onSelect, onOpen, onFocus, onState, onDelete } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [failures, setFailures] = useState<Set<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  const pendingAnchor = useRef<Anchor | undefined>(props.initialAnchor);
  const lastAnchor = useRef<Anchor | undefined>(props.initialAnchor);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const requiredGeometryRevision = useRef(0);
  const [, requestCommit] = useReducer((revision: number) => revision + 1, 0);
  const restoreRequest = useRef<{ anchor?: Anchor; focusId?: string; reveal: boolean; phase: 'geometry' | 'focus' } | null>(null);
  const reportFrame = useRef(0);
  const columns = Math.max(1, Math.floor((width + 10) / (density + 10)));
  const columnWidth = Math.max(1, (width - 10 * (columns - 1)) / columns);
  const layout = `${width}:${columns}:${capTall}`;
  const focusedIndex = pictures.findIndex((picture) => picture.id === focusedId);
  const getItemKey = useCallback((index: number) => pictures[index].id, [pictures, layout]);
  const estimateSize = useCallback((index: number) => {
    const picture = pictures[index];
    const height = columnWidth * picture.height / picture.width;
    return (capTall ? Math.min(height, 560) : height) + 34;
  }, [pictures, columnWidth, capTall]);
  const virtualizer = useVirtualizer({
    count: pictures.length, getScrollElement: () => scrollRef.current,
    getItemKey, estimateSize, lanes: columns, gap: 10,
    overscan: 4, paddingStart: 12, paddingEnd: 80,
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range);
      return focusedIndex < 0 ? indexes : [...new Set([...indexes, focusedIndex])].sort((a, b) => a - b);
    }, [focusedIndex]),
  });
  const capture = useCallback(() => {
    const scroll = scrollRef.current?.scrollTop ?? 0;
    const viewportEnd = scroll + (scrollRef.current?.clientHeight ?? 0);
    const item = virtualizer.getVirtualItems().filter((entry) => entry.end > scroll && entry.start < viewportEnd)
      .sort((a, b) => a.start - b.start)[0];
    return item ? { id: String(item.key), index: item.index, offset: scroll - item.start, scroll, layout, pictures } : undefined;
  }, [virtualizer, layout, pictures]);
  const queueRestore = useCallback((anchor?: Anchor, focusId?: string, reveal = false) => {
    // The next commit has the live canvas height. No scroll write is made against the old sizer.
    restoreRequest.current = { anchor, focusId, reveal, phase: 'geometry' };
    if (focusId) onFocus(focusId);
    requestCommit();
  }, [onFocus]);
  const restore = useCallback((anchor?: Anchor, focusId?: string) => queueRestore(anchor, focusId), [queueRestore]);
  const focusCard = useCallback((id: string) => queueRestore(capture(), id, true), [capture, queueRestore]);
  useImperativeHandle(ref, () => ({ capture: () => capture() ?? lastAnchor.current, restore, focus: focusCard }), [capture, restore, focusCard]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const nextWidth = Math.max(1, element.clientWidth - 24);
      if (Math.abs(nextWidth - width) > 1) {
        pendingAnchor.current = restoreRequest.current?.anchor ?? capture() ?? lastAnchor.current;
        setWidth(nextWidth);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, capture]);
  useLayoutEffect(() => {
    const previousRequest = restoreRequest.current;
    const anchor = pendingAnchor.current ?? previousRequest?.anchor ?? lastAnchor.current;
    // Heights are already fixed by metadata and CSS. Clear only on data/geometry changes,
    // never measure DOM cards or let their rounded offsetHeight alter lane placement.
    virtualizer.measure();
    requiredGeometryRevision.current += 1;
    setGeometryRevision(requiredGeometryRevision.current);
    restoreRequest.current = pictures.length
      ? { anchor, focusId: previousRequest?.focusId, reveal: previousRequest?.reveal ?? false, phase: 'geometry' }
      : null;
    pendingAnchor.current = undefined;
  }, [layout, pictures, virtualizer]);
  useLayoutEffect(() => {
    const request = restoreRequest.current;
    const element = scrollRef.current;
    if (!request || !element || !pictures.length) return;
    const canvas = element.querySelector<HTMLElement>('.masonry-canvas');
    virtualizer.getTotalSize();
    // The rendered revision proves the post-invalidation geometry has committed.
    // CSSOM height serialization loses fractional precision at large magnitudes;
    // comparing that string to the Float64 total can strand an otherwise ready request.
    if (!canvas || Number(canvas.dataset.geometryRevision) !== requiredGeometryRevision.current) return;
    if (request.phase === 'geometry') {
      const anchor = request.anchor;
      let anchorIndex = anchor ? pictures.findIndex((picture) => picture.id === anchor.id) : -1;
      if (anchor && anchorIndex < 0) {
        const currentIds = new Map(pictures.map((picture, index) => [picture.id, index]));
        for (let distance = 1; distance < anchor.pictures.length && anchorIndex < 0; distance++) {
          const next = anchor.pictures[anchor.index + distance];
          const previous = anchor.pictures[anchor.index - distance];
          anchorIndex = (next ? currentIds.get(next.id) : undefined)
            ?? (previous ? currentIds.get(previous.id) : undefined) ?? -1;
        }
      }
      let focusIndex = request.focusId ? pictures.findIndex((picture) => picture.id === request.focusId) : -1;
      if (request.focusId && focusIndex < 0) {
        focusIndex = anchorIndex >= 0 ? anchorIndex : Math.min(anchor?.index ?? 0, pictures.length - 1);
        request.focusId = pictures[focusIndex].id;
        onFocus(request.focusId);
      }
      let offset: number | undefined;
      if (request.reveal && focusIndex >= 0) {
        offset = virtualizer.getOffsetForIndex(focusIndex, 'auto')?.[0];
      } else if (anchor?.layout === layout && anchor.pictures === pictures) {
        offset = anchor.scroll;
      } else if (anchorIndex >= 0 && anchor) {
        // This API clamps to DOM scrollHeight, so call it only after the new canvas commits.
        const start = virtualizer.getOffsetForIndex(anchorIndex, 'start')?.[0];
        offset = start === undefined ? undefined : start + anchor.offset;
      } else if (anchor) offset = 0;
      // Preserve an already matching subpixel scrollTop, including the browser's
      // fractional bottom offset, rather than re-clamping it through integer scrollHeight.
      if (offset !== undefined && element.scrollTop !== Math.max(0, offset)) {
        virtualizer.scrollToOffset(Math.max(0, offset));
      }
      request.phase = 'focus';
      // A distinct commit lets the new virtual range mount before focus, with no delay or loop.
      requestCommit();
      return;
    }
    if (request.focusId) {
      const button = element.querySelector<HTMLButtonElement>(`[data-picture-id="${CSS.escape(request.focusId)}"]`);
      if (!button?.isConnected) {
        // A changed data set may still be committing the roving-focus card.
        if (focusedId !== request.focusId) onFocus(request.focusId);
        return;
      }
      if (button.closest('[inert], [aria-hidden="true"]')) return;
      button.focus({ preventScroll: true });
      if (button.ownerDocument.activeElement !== button) return;
    }
    // Finish only after actual focus succeeds. A later related React commit can
    // finish a pending request; there is no timer, polling, or compensation loop.
    restoreRequest.current = null;
    const anchor = capture();
    if (anchor) lastAnchor.current = anchor;
  });
  useEffect(() => {
    const ids = new Set(pictures.map((picture) => picture.id));
    setFailures((previous) => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [pictures]);
  useEffect(() => () => {
    cancelAnimationFrame(reportFrame.current);
  }, []);
  const virtualItems = virtualizer.getVirtualItems();
  const report = () => {
    const anchor = capture();
    if (anchor && !restoreRequest.current && !pendingAnchor.current) lastAnchor.current = anchor;
    onState({ columns, mounted: virtualizer.getVirtualItems().length, scroll: Math.round(scrollRef.current?.scrollTop ?? 0), width: Math.round(width) });
  };
  useEffect(report, [columns, virtualItems.length, width]);
  const moveFocus = (index: number) => {
    const next = Math.max(0, Math.min(pictures.length - 1, index));
    if (pictures[next]) focusCard(pictures[next].id);
  };
  const failedHere = pictures.some((picture) => failures.has(picture.id));
  const emptyCopy = props.emptyKind === 'no-match'
    ? { title: '没有匹配的参考图', text: '试试更少的标签或其他关键词。', action: '清除搜索与筛选' }
    : props.emptyKind === 'removed-all'
      ? { title: '本次结果已清空', text: '移除只影响此次试用，源文件仍然保留。', action: '恢复本次结果' }
      : { title: '这个资料库还没有图片', text: '选择几张本地参考图，看看它们怎样排列。', action: '选择本地图片' };
  // Keep the same scroll element through empty results, so observers and column measurement stay attached.
  return <div className="masonry-scroll" ref={scrollRef} onScroll={() => {
    cancelAnimationFrame(reportFrame.current);
    reportFrame.current = requestAnimationFrame(report);
  }} aria-label="参考图瀑布流">
    {!pictures.length ? <div className="gallery-empty"><ImageOff size={32} /><h2>{emptyCopy.title}</h2><p>{emptyCopy.text}<br />样稿仅在这次浏览中保留内容。</p><button className="primary-button empty-action" onClick={props.onEmptyAction}>{emptyCopy.action}</button></div> :
      <div className="masonry-canvas" data-geometry-revision={geometryRevision} style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((item) => {
          const picture = pictures[item.index];
          const failed = failures.has(picture.id);
          const height = estimateSize(item.index) - 34;
          return <button className={`picture-card ${selectedId === picture.id ? 'is-selected' : ''}`}
            key={picture.id} data-index={item.index} data-picture-id={picture.id}
            tabIndex={item.index === Math.max(0, focusedIndex) ? 0 : -1}
            aria-label={`${picture.title}，${picture.width} 乘 ${picture.height}，按 Enter 查看`}
            aria-pressed={selectedId === picture.id}
            style={{ width: columnWidth, height: height + 34, left: 12 + item.lane * (columnWidth + 10), top: item.start }}
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
              }
            }}
            onClick={() => onSelect(picture)} onDoubleClick={() => onOpen(picture)} onFocus={() => onFocus(picture.id)}
            onKeyDown={(event) => {
              const targets: Record<string, number> = { ArrowRight: item.index + 1, ArrowLeft: item.index - 1, ArrowDown: item.index + columns, ArrowUp: item.index - columns, Home: 0, End: pictures.length - 1 };
              if (event.key in targets) { event.preventDefault(); event.stopPropagation(); moveFocus(targets[event.key]); }
              if (event.key === 'Enter') { event.preventDefault(); onOpen(picture); }
              if (event.key === ' ') { event.preventDefault(); onSelect(picture); }
              if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); onDelete(picture.id); }
            }}>
            <span className={`picture-frame ${picture.tags.includes('透明') ? 'alpha-ground' : ''}`} style={{ height }}>
              {failed ? <span className="image-failure"><AlertCircle size={22} /><strong>无法读取这张图片</strong><span>单项失败 · 双击查看恢复操作</span></span> :
                <img key={retry} src={picture.url} alt="" decoding="async" loading="lazy" draggable={false}
                  onError={() => setFailures((previous) => new Set(previous).add(picture.id))} />}
            </span>
            <span className="picture-caption"><span title={picture.title}>{picture.title}</span><small>{picture.kind === 'local' ? '本地' : picture.kind === 'fixture' || picture.kind === 'error' ? '夹具' : '样本'}</small></span>
          </button>;
        })}
      </div>}
    {failedHere && <button className="retry-hint" onClick={() => { setFailures(new Set()); setRetry((value) => value + 1); }}>重试失败图片</button>}
  </div>;
});
export default Masonry;
