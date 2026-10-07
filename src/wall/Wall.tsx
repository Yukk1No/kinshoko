import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { flushSync } from "react-dom";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ConditionTree } from "../bindings/ConditionTree";
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
  /** Search 给出的条件树；没有条件时是范围内的全部。条件变化时由调用方换 key 重建，从顶部看起。 */
  conditions?: ConditionTree;
  /** 资料库报告列表过期时递增：重新浏览，保持正在看的位置。 */
  reloadKey: number;
  /**
   * 安全模式（#60）。开启的一刻，还在墙上的含成人内容的图立即遮蔽（模糊并覆上墨色），
   * 等重新浏览后离开；关闭后回来的图先遮着，下一帧淡出遮蔽。
   */
  safeMode?: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
  onOpenImage: (card: ImageCard) => void;
  viewerOpen: boolean;
  /** 侧栏宽度动画期间保留布局；结束后按最终宽度重排一次。 */
  holdReflow?: boolean;
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

const NO_CONDITIONS: ConditionTree = { conditions: [] };

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
 * 换范围或条件时由调用方换 key 重建。查找结果不记住位置，新的查找从顶部看起。
 */
export function Wall({
  libraryId,
  scope,
  conditions = NO_CONDITIONS,
  reloadKey,
  safeMode = true,
  selected,
  onSelectionChange,
  onOpenImage,
  viewerOpen,
  holdReflow = false,
}: Props) {
  const searching = conditions.conditions.length > 0;
  const storeKey = searching ? null : anchorKey(libraryId, scope);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [cards, setCards] = useState<ImageCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const loading = useRef(false);
  /** 正在看的那张图。重开或重新浏览后滚回这里。 */
  const anchor = useRef<Anchor | null>(storeKey ? loadAnchor(storeKey) : null);
  /** Shift 单击的起点。 */
  const pivot = useRef<string | null>(null);
  const restoring = useRef(true);
  const settledTop = useRef<number | null>(null);
  const lastOpened = useRef<string | null>(null);
  const wasViewing = useRef(false);
  const layoutWidth = useRef(0);
  const beforeReflow = useRef(new Map<string, DOMRect>());
  const motions = useRef(new Map<string, Animation>());

  const measureBeforeReflow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const viewport = el.getBoundingClientRect();
    const measured = new Map<string, DOMRect>();
    // 先读完所有当前矩形（包括动画中途的位置），再取消动画。
    el.querySelectorAll<HTMLElement>(".card").forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom >= viewport.top && rect.top <= viewport.bottom) {
        measured.set(node.dataset.id!, rect);
      }
    });
    motions.current.forEach((motion) => motion.cancel());
    motions.current.clear();
    beforeReflow.current = measured;
  }, []);

  useEffect(() => () => { motions.current.forEach((motion) => motion.cancel()); }, []);

  useLayoutEffect(() => {
    if (wasViewing.current && !viewerOpen && lastOpened.current) {
      const card = scroller.current?.querySelector<HTMLElement>(`[data-id="${lastOpened.current}"]`);
      card?.focus({ preventScroll: true });
    }
    wasViewing.current = viewerOpen;
  }, [viewerOpen]);

  const open = (card: ImageCard) => {
    lastOpened.current = card.id;
    onOpenImage(card);
  };

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
          const page = await browse(libraryId, { scope, conditions, cursor: after, limit: PAGE, thumbnailPx });
          if (!alive.current) return;
          next.push(...page.cards);
          after = page.nextCursor;
          count = page.total;
          // 恢复位置时一直取到锚定的那张图为止。
          const target = restoring.current ? anchor.current?.id : undefined;
          if (next.length >= want && !(target && !next.some((c) => c.id === target))) break;
        } while (after);
        measureBeforeReflow();
        setCards(next);
        setCursor(after);
        setTotal(count);
        setError(null);
      } catch (e) {
        if (alive.current) setError(String(e));
      } finally {
        loading.current = false;
      }
    },
    // 范围或条件变化时调用方会换 key 重建，不必列为依赖。
    [thumbnailPx],
  );

  const loadMore = useCallback(async () => {
    if (loading.current || !cursor) return;
    loading.current = true;
    try {
      const page = await browse(libraryId, { scope, conditions, cursor, limit: PAGE, thumbnailPx });
      if (!alive.current) return;
      measureBeforeReflow();
      setCards((prev) => [...prev, ...page.cards]);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (alive.current) setError(String(e));
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
      if (!holdReflow && el.clientWidth !== layoutWidth.current) {
        measureBeforeReflow();
        layoutWidth.current = el.clientWidth;
        setWidth(el.clientWidth);
      }
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => flushSync(sync));
    ro.observe(el);
    return () => ro.disconnect();
  }, [holdReflow, measureBeforeReflow]);

  /** 已经放出（不再遮蔽）的含成人内容的图。 */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (safeMode) {
      setRevealed(new Set());
      return;
    }
    // 先以遮蔽的样子出现，下一帧再放出，遮蔽才有过渡可以淡出。
    const frame = requestAnimationFrame(() =>
      setRevealed(new Set(cards.filter((c) => c.adult).map((c) => c.id))),
    );
    return () => cancelAnimationFrame(frame);
  }, [cards, safeMode]);

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
    const from = beforeReflow.current;
    beforeReflow.current = new Map();
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const targets = [...el.querySelectorAll<HTMLElement>(".card")].map((node) => ({ node, old: from.get(node.dataset.id!), next: node.getBoundingClientRect() }));
      for (const { node, old, next } of targets) {
        if (!old || !next.width || !next.height || typeof node.animate !== "function") continue;
        const motion = node.animate([
          { transform: `translate(${old.left - next.left}px, ${old.top - next.top}px) scale(${old.width / next.width}, ${old.height / next.height})` },
          { transform: "none" },
        ], { duration: 200, easing: "cubic-bezier(0.2,0.8,0.2,1)" });
        motions.current.set(node.dataset.id!, motion);
        motion.onfinish = () => motions.current.delete(node.dataset.id!);
      }
    }
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, [layout, ids, width, cards.length, cursor]);

  const onScroll = () => {
    const el = scroller.current!;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    // 自己为锚点做的滚动不重新取锚，否则每次重排都会漂到另一张图。
    const own = settledTop.current !== null && Math.abs(el.scrollTop - settledTop.current) < 1;
    if (own || restoring.current) return;
    settledTop.current = null;
    anchor.current = captureAnchor(layout, ids, el.scrollTop, el.clientHeight);
    if (storeKey) saveAnchor(storeKey, anchor.current);
  };

  // 接近底部时取下一页。
  useEffect(() => {
    if (cursor && viewport.top + viewport.height + OVERSCAN * 2 >= layout.height) void loadMore();
  }, [cursor, viewport, layout.height, loadMore]);

  const mounted = useMemo(() => {
    const found = visible(layout, viewport.top - OVERSCAN, viewport.top + viewport.height + OVERSCAN);
    // 查看器里调整窗口宽度后，最后查看的卡片仍能接回焦点（最多多保留一张）。
    const last = ids.indexOf(lastOpened.current ?? "");
    if (last >= 0 && !found.includes(last)) found.push(last);
    for (const id of [...beforeReflow.current.keys(), ...motions.current.keys()]) {
      const i = ids.indexOf(id);
      if (i >= 0 && !found.includes(i)) found.push(i);
    }
    return found.sort((a, b) => a - b);
  }, [layout, viewport, ids, viewerOpen]);

  const select = (id: string, e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">) => {
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
    <div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}
      role="listbox" aria-label="图片墙" aria-multiselectable="true" tabIndex={-1}>
      {error && <p role="alert">{error}</p>}
      {total === 0 ? (
        <p className="wall-empty">{searching ? "没有符合条件的参考图。" : EMPTY[scope.kind]}</p>
      ) : (
        <div className="wall-canvas" style={{ height: layout.height }}>
          {mounted.map((i) => {
            const card = cards[i];
            const b = layout.boxes[i];
            const veiled = card.adult && (safeMode || !revealed.has(card.id));
            return (
              <div
                key={card.id}
                className="card"
                data-id={card.id}
                aria-selected={selected.has(card.id)}
                role="option"
                tabIndex={0}
                data-veiled={veiled}
                draggable
                onClick={(e) => select(card.id, e)}
                onDoubleClick={() => open(card)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); open(card); }
                  if (e.key === " ") { e.preventDefault(); select(card.id, e); }
                }}
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
