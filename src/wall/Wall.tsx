import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ImageCard } from "../bindings/ImageCard";
import { browse, thumbnailUrl } from "../ipc";
import { captureAnchor, masonry, resolveAnchor, visible, type Anchor } from "./layout";

// 常量沿用 #13 样稿（Wall.tsx）。
const GAP = 8;
const PAD = 12;
const OVERSCAN = 700;
/** 目标列宽（CSS 像素），样稿的默认密度。 */
const TARGET = 240;
/** 特别长的图整体缩小到列宽的 2.6 倍高，不裁切。 */
const CAP_RATIO = 2.6;
const PAGE = 500;

/** 图片墙上拖出参考图时放进 dataTransfer 的类型，值为 JSON 数组的参考图 id。 */
export const DRAG_IMAGES = "application/x-kinshoko-images";

type Props = {
  libraryId: string;
  scope: BrowseScope;
  /** 资料库报告列表过期时递增：重新浏览，保持正在看的位置。 */
  reloadKey: number;
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
};

/** 每个范围各自记住位置。“全部”沿用 #44 的键。 */
export const scopeKey = (scope: BrowseScope) =>
  scope.kind === "folder" ? `folder.${scope.id}` : scope.kind;

const anchorKey = (libraryId: string, scope: BrowseScope) =>
  scope.kind === "all"
    ? `kinshoko.wall.anchor.${libraryId}`
    : `kinshoko.wall.anchor.${libraryId}.${scopeKey(scope)}`;

const EMPTY: Record<BrowseScope["kind"], string> = {
  all: "资料库里还没有参考图。从上方导入图片或文件夹。",
  folder: "这个文件夹里还没有参考图。选中图片后用“放入文件夹”，或把图片拖到侧栏的文件夹上。",
  trash: "回收站是空的。",
};

function loadAnchor(key: string): Anchor | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Anchor) : null;
  } catch {
    return null;
  }
}

function saveAnchor(key: string, anchor: Anchor | null) {
  try {
    if (anchor) localStorage.setItem(key, JSON.stringify(anchor));
  } catch {
    // 本地存储不可用时只是不记住位置。
  }
}

/**
 * 图片墙：按资料库记录的尺寸用纯函数排出瀑布流，只挂载视口附近的卡片。
 * 单击选中一张，Ctrl 单击增减，Shift 单击选中一段；选中的图可以拖到侧栏的文件夹上。
 * 换范围时由调用方换 key 重建。
 */
export function Wall({ libraryId, scope, reloadKey, selected, onSelectionChange }: Props) {
  const storeKey = anchorKey(libraryId, scope);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [cards, setCards] = useState<ImageCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const loading = useRef(false);
  /** 正在看的那张图。重开或重新浏览后滚回这里。 */
  const anchor = useRef<Anchor | null>(loadAnchor(storeKey));
  /** Shift 单击的起点。 */
  const pivot = useRef<string | null>(null);
  const restoring = useRef(true);
  const settledTop = useRef<number | null>(null);

  const thumbnailPx = useMemo(
    () => Math.ceil(TARGET * 1.5 * (window.devicePixelRatio || 1)),
    [],
  );

  /** 从头取至少 want 张，一次替换，避免列表闪空。 */
  const reload = useCallback(
    async (want: number) => {
      loading.current = true;
      try {
        const next: ImageCard[] = [];
        let after: string | null = null;
        let count = 0;
        do {
          const page = await browse({ scope, cursor: after, limit: PAGE, thumbnailPx });
          next.push(...page.cards);
          after = page.nextCursor;
          count = page.total;
          // 恢复位置时一直取到锚定的那张图为止。
          const target = restoring.current ? anchor.current?.id : undefined;
          if (next.length >= want && !(target && !next.some((c) => c.id === target))) break;
        } while (after);
        setCards(next);
        setCursor(after);
        setTotal(count);
      } finally {
        loading.current = false;
      }
    },
    // 范围变化时调用方会换 key 重建，scope 不必列为依赖。
    [thumbnailPx],
  );

  const loadMore = useCallback(async () => {
    if (loading.current || !cursor) return;
    loading.current = true;
    try {
      const page = await browse({ scope, cursor, limit: PAGE, thumbnailPx });
      setCards((prev) => [...prev, ...page.cards]);
      setCursor(page.nextCursor);
      setTotal(page.total);
    } finally {
      loading.current = false;
    }
  }, [cursor, thumbnailPx]);

  const loaded = useRef(0);
  loaded.current = cards.length;
  useEffect(() => {
    void reload(Math.max(loaded.current, PAGE));
  }, [reload, reloadKey]);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      setWidth(el.clientWidth);
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ids = useMemo(() => cards.map((c) => c.id), [cards]);
  const layout = useMemo(
    () =>
      masonry(
        cards.map((c) => ({ w: c.width, h: c.height })),
        { width, target: TARGET, gap: GAP, pad: PAD, capRatio: CAP_RATIO },
      ),
    [cards, width],
  );

  // 布局变化（宽度、新的一批卡片）后把锚定的图放回原来的位置。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !width || !cards.length) return;
    const top = resolveAnchor(layout, ids, anchor.current);
    if (top !== null && Math.abs(el.scrollTop - top) > 0.5) {
      el.scrollTop = top;
      settledTop.current = el.scrollTop;
    }
    // 锚定的图找到了，或已取完全部仍没有（图已不在），都结束恢复。
    if (top !== null || !anchor.current || !cursor) restoring.current = false;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, [layout, ids, width, cards.length, cursor]);

  const onScroll = () => {
    const el = scroller.current!;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // 自己为锚点做的滚动不重新取锚，否则每次重排都会漂到另一张图。
    const own = settledTop.current !== null && Math.abs(el.scrollTop - settledTop.current) < 1;
    settledTop.current = null;
    if (own || restoring.current) return;
    anchor.current = captureAnchor(layout, ids, el.scrollTop, el.clientHeight);
    saveAnchor(storeKey, anchor.current);
  };

  // 接近底部时取下一页。
  useEffect(() => {
    if (cursor && viewport.top + viewport.height + OVERSCAN * 2 >= layout.height) void loadMore();
  }, [cursor, viewport, layout.height, loadMore]);

  const mounted = useMemo(
    () => visible(layout, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN),
    [layout, viewport],
  );

  const select = (id: string, e: MouseEvent) => {
    if (e.shiftKey && pivot.current && ids.includes(pivot.current)) {
      const [a, b] = [ids.indexOf(pivot.current), ids.indexOf(id)].sort((x, y) => x - y);
      const next = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
      ids.slice(a, b + 1).forEach((x) => next.add(x));
      onSelectionChange(next);
      return;
    }
    pivot.current = id;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(id)) next.add(id);
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([id]));
    }
  };

  const dragStart = (id: string, e: DragEvent) => {
    // 拖未选中的图时只拖这一张，并改为选中它。
    let dragged = [...selected];
    if (!selected.has(id)) {
      dragged = [id];
      pivot.current = id;
      onSelectionChange(new Set(dragged));
    }
    e.dataTransfer.setData(DRAG_IMAGES, JSON.stringify(dragged));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  return (
    <div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}>
      {total === 0 ? (
        <p className="wall-empty">{EMPTY[scope.kind]}</p>
      ) : (
        <div className="wall-canvas" style={{ height: layout.height }}>
          {mounted.map((i) => {
            const card = cards[i];
            const b = layout.boxes[i];
            return (
              <div
                key={card.id}
                className="card"
                data-id={card.id}
                aria-selected={selected.has(card.id)}
                draggable
                onClick={(e) => select(card.id, e)}
                onDragStart={(e) => dragStart(card.id, e)}
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }}
              >
                <img src={thumbnailUrl(card.thumbnail)} alt="参考图" decoding="async" draggable={false} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
