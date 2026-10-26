import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MenuPopup } from "../ui/Menu";
import type { WallMenuTarget } from "./WallMenu";
import { captureAnchor, masonry, visible, type Anchor, type Box } from "./layout";
import { createNotchCounter } from "./zoom";
import type { createSmoothWheel } from "./smoothWheel";
import { mountWindow, type MountWindow } from "./prefetch";
import { useUiScale } from "../shell/uiScale";
import { useDevicePixelRatio } from "../ui/devicePixelRatio";
import {
  CAP_RATIO, EMPTY, GAP, NO_CONDITIONS, OVERSCAN, PAD, SAVE_ANCHOR_MS, TARGET, anchorKey, loadAnchor,
  saveAnchor, type BrowserCard, type LayoutSnapshot, type WallHandle, type WallProps,
} from "./wallShared";
import { wallCardNode, type CardHandlers } from "./WallCard";
import { useDoubleClickGuard } from "./useDoubleClickGuard";
import { useWallPages } from "./useWallPages";
import { useReleaseLanding, useSealRelease } from "./useSealRelease";
import { useMeasureBeforeReflow, useReflowAfterLayout, useWidthSync } from "./useReflow";
import { usePrefetchThumbnails } from "./usePrefetchThumbnails";
import { useReturnFocus, useViewerLeave } from "./useViewerReturn";
import { useWallCaptureSources } from "./useWallCaptureSources";
import { useWallZoom, type ZoomState } from "./useWallZoom";
import { usePasteShortcut, wallInteractions } from "./wallInteractions";

export { DRAG_IMAGE_SOURCES, DRAG_IMAGES, scopeKey } from "./wallShared";
export type { BrowserCard, CardCommand, WallHandle } from "./wallShared";

/**
 * 图片墙：按资料库记录的尺寸用纯函数排出瀑布流，只挂载视口附近的卡片。
 * 单击只选中这一张（详情面板跟着选择），再单击当前唯一选中的那张、双击或 Enter 打开查看器（#146、#179）；
 * 双击按第一下的图判定：第二下落在哪里都打开第一下的那张。
 * Ctrl 单击增减选择，Shift 单击选中一段，单击空白处清空选择；选中的图可以拖到文件夹上。
 * 换范围或条件时由调用方换 key 重建。查找结果不记住位置，新的查找从顶部看起。
 */
export const Wall = forwardRef<WallHandle, WallProps>(function Wall({
  workspaceScope,
  onInspectSources,
  onCardsChange,
  onWorkspaceStatus,
  density = TARGET,
  onDensityPreview,
  onDensityCommit,
  onTotalChange,
  libraryId,
  scope,
  conditions = NO_CONDITIONS,
  reloadKey,
  safeMode = true,
  holdReflow = false,
  selected,
  onSelectionChange,
  onOpenImage,
  viewerOpen,
  menu,
  onCardCommand,
  onPaste,
}, ref) {
  const searching = conditions.conditions.length > 0;
  const storeKey = searching ? null : workspaceScope ? `kinshoko.wall.workspace.${JSON.stringify(workspaceScope)}` : anchorKey(libraryId, scope);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [previewDensity, setPreviewDensity] = useState<number | null>(null);
  /**
   * 挂载范围（#109）：按块更新，滚动没有越出余量时不变，滚动事件因此不触发 React 渲染。
   * 状态只在范围变化时设，同值的 setState 不进渲染。
   */
  const [mount, setMount] = useState<MountWindow>({ top: 0, bottom: 0 });
  const mountRef = useRef<MountWindow | null>(null);
  const syncMount = useCallback((el: HTMLElement) => {
    const next = mountWindow(mountRef.current, el.scrollTop, el.clientHeight, OVERSCAN);
    if (next === mountRef.current) return;
    mountRef.current = next;
    setMount(next);
  }, []);
  /** 最近的滚动方向（1 向下，−1 向上），决定往哪边预取。 */
  const scrollDirection = useRef<1 | -1>(1);
  const lastScrollTop = useRef(0);
  const [cards, setCards] = useState<BrowserCard[]>([]);
  /** 墙上现在的卡片，给异步回来的页面和动画计时比较用。 */
  const shownCards = useRef(cards);
  shownCards.current = cards;
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onTotalChange?.(total); }, [onTotalChange, total]);
  /**
   * 请求代次：重新浏览、视角（资料库、范围、条件、安全模式）变化与卸载时前进。
   * 响应回来时代次已经不同就整个丢掉，不改卡片、游标、数量、错误与加载状态（#77 UI-A）。
   */
  const generation = useRef(0);
  /** 正在进行的请求所属代次；没有时为 null。被作废的请求不会占着它。 */
  const inflight = useRef<number | null>(null);
  /** 当前视角。请求发出时按这里取，不用首次渲染时的值。 */
  const view = useRef({ libraryId, scope, conditions, workspaceScope, safeMode });
  view.current = { libraryId, scope, conditions, workspaceScope, safeMode };
  const lens = `${libraryId}\n${JSON.stringify(scope)}\n${JSON.stringify(conditions)}\n${safeMode}\n${JSON.stringify(workspaceScope)}`;
  useLayoutEffect(() => {
    // 视角变了：还在路上的请求按旧视角作废，旧游标也不再接着翻；等调用方按新视角重新浏览。
    generation.current += 1;
    inflight.current = null;
    setCursor(null);
    return () => {
      generation.current += 1;
      inflight.current = null;
    };
  }, [lens]);
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
  /**
   * 安全模式切换那一刻量下的卡片位置。资料库按新视角送回卡片后，留下的卡片从这里滑到新位置，
   * 节奏按原型的封印／释放重排（从点下去的时刻算起）。
   */
  const safeReflow = useRef<{
    rects: Map<string, DOMRect>; boxes: LayoutSnapshot; at: number; delay: number; duration: number;
    /** 存下之后卡片又被别的重排挪过（例如墙变宽）：起点按用时量到的位置，不用存下的。 */
    moved?: boolean;
  } | null>(null);
  /** 封印／释放重排前的布局：点下去时不在视口里的卡片，从这里算出起点（#154）。 */
  const beforeBoxes = useRef<LayoutSnapshot | null>(null);
  /** 这一次重排的节奏；null 时是平常的 200 ms。 */
  const reflowMotion = useRef<{ at: number; delay: number; duration: number } | null>(null);

  /** 原生滚轮监听读最新的渲染结果。 */
  const live = useRef({ layout: null as ReturnType<typeof masonry> | null, ids: [] as string[], density, previewDensity, onDensityPreview, onDensityCommit });
  /** 关闭后资料库按新视角送回的那一页已经到了：之后再来的成人图不算这次释放。 */
  const releasePage = useRef(false);
  const measureBeforeReflow = useMeasureBeforeReflow({ scroller, motions, safeReflow, reflowMotion, beforeReflow, beforeBoxes, live });

  useEffect(() => () => { motions.current.forEach((motion) => motion.cancel()); }, []);
  /** 封印后按原型节奏移走飞走的图的那一帧（requestAnimationFrame id）；0 表示没有。 */
  const sealDrop = useRef(0);
  useEffect(() => () => cancelAnimationFrame(sealDrop.current), []);
  const loadMoreRef = useRef<() => void>(() => {});
  const selectAllRef = useRef<() => void>(() => {});
  useImperativeHandle(ref, () => ({
    previewDensity(value) { measureBeforeReflow(); setPreviewDensity(value); },
    invalidate() { generation.current += 1; inflight.current = null; },
    loadMore() { loadMoreRef.current(); },
    selectAll() { selectAllRef.current(); },
    remove(ids) {
      const removing = new Set(ids);
      /** 移走时墙上每张卡片的位置：放回时按它排回原来的先后。 */
      const rank = new Map(shownCards.current.map((card, index) => [card.id, index]));
      let removed = shownCards.current.filter((card) => removing.has(card.id));
      if (!removed.length) return () => {};
      // 还在路上的下一页是按移走前的卡片拼的，回来会把移走的卡片带回来：作废它。整理完的重新浏览会再取。
      generation.current += 1;
      inflight.current = null;
      measureBeforeReflow();
      setCards((now) => now.filter((card) => !removing.has(card.id)));
      setTotal((count) => (count === null ? count : count - removed.length));
      return (failedIds) => {
        const failing = new Set(failedIds);
        const shown = new Set(shownCards.current.map((card) => card.id));
        const returning = removed.filter((card) => failing.has(card.id) && !shown.has(card.id));
        removed = removed.filter((card) => !returning.includes(card));
        if (!returning.length) return;
        generation.current += 1;
        inflight.current = null;
        measureBeforeReflow();
        // 一次归并：放回的卡片按原来的位置，插到原来排在它后面的第一张墙上卡片之前。
        const back = [...returning].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
        setCards((now) => {
          const present = new Set(now.map((card) => card.id));
          const pending = back.filter((card) => !present.has(card.id));
          const next: BrowserCard[] = [];
          let i = 0;
          for (const card of now) {
            const at = rank.get(card.id);
            if (at !== undefined) while (i < pending.length && rank.get(pending[i].id)! < at) next.push(pending[i++]);
            next.push(card);
          }
          next.push(...pending.slice(i));
          return next;
        });
        setTotal((count) => (count === null ? count : count + returning.length));
      };
    },
  }), [measureBeforeReflow]);
  useLayoutEffect(() => { setPreviewDensity(null); }, [density]);

  /**
   * Ctrl+滚轮缩放（#111）：光标下的那张图在预览后的布局里中心仍在光标的高度（列数会变，只锚纵向，#122）。只由下一次布局效果消费一次；
   * 滑条与键盘改密度不设它，仍以视口顶部的图为锚。
   */
  const zoomPin = useRef<{ id: string; pointerY: number } | null>(null);
  const zoom = useRef<ZoomState>({ value: null, timer: 0, count: createNotchCounter(), pin: null });
  const smoothRef = useRef<ReturnType<typeof createSmoothWheel> | null>(null);

  const returnTo = useViewerLeave({ viewerOpen, selected, lastOpened, wasViewing, smoothRef });

  const open = (card: BrowserCard) => {
    pivot.current = card.id;
    lastOpened.current = card.id;
    onOpenImage(card);
  };

  const { pendingClick, lastPress, openById } = useDoubleClickGuard();
  openById.current = (id) => { const card = cards.find((c) => c.id === id); if (card) open(card); };


  // 界面缩放（#173）：图片大小是界面缩放 100% 时的 CSS 宽度，卡片按界面缩放缩小 CSS 宽度，
  // 屏幕上的宽度与每行张数不变。缩略图按卡片的 CSS 宽度乘实际的设备像素比请求。
  const uiScale = useUiScale();
  const dpr = useDevicePixelRatio();
  const thumbnailPx = useMemo(
    () => Math.ceil((density / uiScale) * 1.5 * dpr),
    [density, uiScale, dpr],
  );

  useEffect(() => { onCardsChange?.(cards); }, [cards, onCardsChange]);
  useWallCaptureSources({ viewerOpen, scroller, cards, libraryId });
  const { loadMore } = useWallPages({
    cards, setCards, cursor, setCursor, setTotal, setError, generation, inflight, view, restoring, anchor, shownCards,
    measureBeforeReflow, onWorkspaceStatus, releasePage, thumbnailPx, reloadKey, loadMoreRef, workspaceScope, safeMode,
  });

  const { holdForDoubleClick } = useWidthSync({ holdReflow, scroller, layoutWidth, measureBeforeReflow, setWidth, syncMount });

  const { revealed, arriving, fxHost, fx, releaseDue, book, releaseOnScreen } = useSealRelease({
    safeMode, cards, setCards, scroller, shownCards, live, safeReflow, sealDrop, measureBeforeReflow, viewerOpen, releasePage,
  });

  const ids = useMemo(() => cards.map((c) => c.id), [cards]);
  const layout = useMemo(
    () =>
      masonry(
        cards.map((c) => ({ w: c.width, h: c.height })),
        { width, target: (previewDensity ?? density) / uiScale, gap: GAP / uiScale, pad: PAD / uiScale, capRatio: CAP_RATIO },
      ),
    [cards, width, density, previewDensity, uiScale],
  );

  useReflowAfterLayout({
    scroller, width, cards, zoomPin, ids, layout, anchor, storeKey, settledTop, cursor, restoring, beforeReflow, reflowMotion,
    beforeBoxes, syncMount, motions,
  });

  live.current = { layout, ids, density, previewDensity, onDensityPreview, onDensityCommit };

  useWallZoom({ scroller, zoom, live, smoothRef, zoomPin, setPreviewDensity, measureBeforeReflow });

  /** 停手后才写本地存储（#109：不在每个滚动事件里同步写）；卸载与页面隐藏时立即写。 */
  const pendingSave = useRef<{ key: string; timer: number } | null>(null);
  const flushSave = useCallback(() => {
    const pending = pendingSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSave.current = null;
    saveAnchor(pending.key, anchor.current);
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => { window.removeEventListener("pagehide", flushSave); flushSave(); };
  }, [flushSave]);

  useReleaseLanding({ releaseDue, safeMode, cards, layout, width, releasePage, fx, book, viewerOpen, releaseOnScreen });

  const onScroll = () => {
    const el = scroller.current!;
    syncMount(el);
    if (el.scrollTop !== lastScrollTop.current) scrollDirection.current = el.scrollTop > lastScrollTop.current ? 1 : -1;
    lastScrollTop.current = el.scrollTop;
    // 自己为锚点做的滚动不重新取锚，否则每次重排都会漂到另一张图。
    const own = settledTop.current !== null && Math.abs(el.scrollTop - settledTop.current) < 1;
    if (own || restoring.current) return;
    settledTop.current = null;
    anchor.current = captureAnchor(layout, ids, el.scrollTop, el.clientHeight);
    if (storeKey) {
      if (pendingSave.current) clearTimeout(pendingSave.current.timer);
      pendingSave.current = { key: storeKey, timer: window.setTimeout(flushSave, SAVE_ANCHOR_MS) };
    }
  };

  // 接近底部时取下一页。
  useEffect(() => {
    if (cursor && mount.bottom + OVERSCAN * 2 >= layout.height) void loadMore();
  }, [cursor, mount, layout.height, loadMore]);

  const position = useMemo(() => new Map(ids.map((id, i) => [id, i])), [ids]);
  const mounted = useMemo(() => {
    const found = new Set(visible(layout, mount.top, mount.bottom));
    // 查看器里调整窗口宽度后，最后查看的卡片仍能接回焦点（最多多保留一张）。
    for (const id of [lastOpened.current, ...beforeReflow.current.keys(), ...motions.current.keys()]) {
      const i = id === null ? undefined : position.get(id);
      if (i !== undefined) found.add(i);
    }
    return [...found].sort((a, b) => a - b);
  }, [layout, mount, position, viewerOpen, selected]);

  useReturnFocus({ returnTo, scroller, position, layout, syncMount });

  /** 上次渲染的卡片元素，按 id；布局、选择、遮蔽都没变的卡片原样沿用。 */
  const renderedCards = useRef(new Map<string, { card: BrowserCard; box: Box; chosen: boolean; veiled: boolean; leaving: boolean; landing: boolean; node: ReactNode }>());
  useLayoutEffect(() => { renderedCards.current = nextRendered; });
  const cardHandlers = useRef<CardHandlers>(null!);
  usePrefetchThumbnails({ layout, mount, cards, scrollDirection });

  const [menuTarget, setMenuTarget] = useState<WallMenuTarget | null>(null);
  const { click, clearOnBlankClick, targetMenu, cardKey, wallKey, dragStart } = wallInteractions({
    ids, cards, selected, onSelectionChange, pivot, lastPress, pendingClick, holdForDoubleClick, open, selectAllRef,
    setMenuTarget, menu, onCardCommand, scope, workspaceScope,
  });
  selectAllRef.current = () => onSelectionChange(new Set(ids));

  usePasteShortcut({ onPaste, viewerOpen, scroller });


  // 卡片的事件处理读这里的最新版本，沿用的卡片元素因此不会拿着旧的选择与回调。
  cardHandlers.current = { click, open, cardKey, dragStart, inspect: onInspectSources };
  const nextRendered: typeof renderedCards.current = new Map();

  return (
    <ContextMenu.Root disabled={!menu} onOpenChange={(next) => { if (!next) setMenuTarget(null); }}>
    <ContextMenu.Trigger render={<div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}
      role="listbox" aria-label="图片墙" aria-multiselectable="true" tabIndex={-1} onKeyDown={wallKey} onClick={clearOnBlankClick}
      inert={viewerOpen}
      onContextMenuCapture={(e) => { if (menu) targetMenu(e); }} />}>
      {error && <p role="alert">{error}</p>}
      {total === 0 ? (
        <p className="wall-empty">{searching ? "没有符合条件的参考图。" : EMPTY[scope.kind]}</p>
      ) : (
        <div className="wall-canvas" style={{ height: layout.height }}>
          {mounted.map((i) => {
            const card = cards[i];
            const b = layout.boxes[i];
            const veiled = card.adult && (safeMode || !revealed.has(card.id));
            // 安全模式下墙上的成人卡片只会是刚开启、等资料库确认的那些：影子已替它飞向封印书，
            // 原地不再留着遮蔽的图，只先占着位置，确认后其余卡片再补位（#154）。
            const leaving = card.adult && safeMode;
            const chosen = selected.has(card.id);
            const landing = arriving.has(card.id);
            // 没变的卡片沿用上次的元素，React 跳过整张卡片的比对（#109）。
            const kept = renderedCards.current.get(card.id);
            if (kept && kept.card === card && kept.box === b && kept.chosen === chosen && kept.veiled === veiled && kept.leaving === leaving && kept.landing === landing) {
              nextRendered.set(card.id, kept);
              return kept.node;
            }
            const node = wallCardNode({ card, b, landing, veiled, leaving, selected, workspaceScope, cardHandlers, lastOpened });
            nextRendered.set(card.id, { card, box: b, chosen, veiled, leaving, landing, node });
            return node;
          })}
        </div>
      )}
      {createPortal(<div className="fx-layer" ref={fxHost} aria-hidden="true" />, document.body)}
    </ContextMenu.Trigger>
    {menu && menuTarget && <MenuPopup label={menuTarget.kind === "blank" ? "图片墙菜单" : menuTarget.cards.length > 1 ? `${menuTarget.cards.length} 张参考图的菜单` : "参考图菜单"} width={232}>
      {menu(menuTarget)}
    </MenuPopup>}
    </ContextMenu.Root>
  );
});
