import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MenuPopup } from "../ui/Menu";
import type { WallMenuTarget } from "./WallMenu";
import { captureAnchor, masonry, type Anchor, type Box } from "./layout";
import { createNotchCounter } from "./zoom";
import type { createSmoothWheel } from "./smoothWheel";
import { mountWindow, type MountWindow } from "./prefetch";
import { useUiScale } from "../shell/uiScale";
import { useDevicePixelRatio } from "../ui/devicePixelRatio";
import {
  CAP_RATIO, GAP, NO_CONDITIONS, OVERSCAN, PAD, SAVE_ANCHOR_MS, SCROLLING_MS, TARGET, loadAnchor,
  saveAnchor, type BrowserCard, type WallProps,
} from "./wallShared";
import { wallCardNode, type CardHandlers } from "./WallCard";
import { layoutItems, storableAnchor, TRAY_PAD, useCloseTrayOnTopbar, useOpenTray, veiledSheets } from "./imageSets";
import { useTrayMotion } from "./useTrayMotion";
import { useWallHandle } from "./useWallHandle";
import { useDoubleClickGuard } from "./useDoubleClickGuard";
import { useWallPages } from "./useWallPages";
import { useReleaseLanding, useSealRelease } from "./useSealRelease";
import { useMeasureBeforeReflow, useReflowAfterLayout, useReflowState, useWidthSync } from "./useReflow";
import { usePrefetchThumbnails } from "./usePrefetchThumbnails";
import { thumbnailTier } from "./thumbnailTier";
import { useReturnFocus, useViewerLeave } from "./useViewerReturn";
import { useWallCaptureSources } from "./useWallCaptureSources";
import { useWallZoom, type ZoomState } from "./useWallZoom";
import { useMountedCards } from "./useMountedCards";
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
export function Wall({
  workspaceScope,
  onInspectSources,
  onCardsChange,
  onWorkspaceStatus,
  density = TARGET,
  onDensityPreview,
  onDensityCommit,
  onTotalChange,
  scope,
  conditions = NO_CONDITIONS,
  reloadKey,
  safeMode = true,
  holdReflow = false,
  settle = null,
  selected,
  onSelectionChange,
  onOpenImage,
  viewerOpen,
  menu,
  onCardCommand,
  onPaste,
  emptyAction,
  stackSets = false,
  ref,
}: WallProps) {
  const searching = conditions.conditions.length > 0;
  const storeKey = searching ? null : `kinshoko.wall.workspace.${JSON.stringify(workspaceScope)}`;
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
  /** 墙上实际排的格子（#418）：打开托盘的那一摞换成它的各页。 */
  const { openSet, setOpenSet, shown, tray, trayIds } = useOpenTray(cards, stackSets);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 叠在一摞里、不占格子的张数（#418）；顶栏报的是张数，不是格数。 */
  const [stacked, setStacked] = useState(0);
  useEffect(() => { onTotalChange?.(total === null ? null : total + stacked); }, [onTotalChange, total, stacked]);
  /**
   * 请求代次：重新浏览、视角（浏览范围、条件、安全模式）变化与卸载时前进。
   * 响应回来时代次已经不同就整个丢掉，不改卡片、游标、数量、错误与加载状态（#77 UI-A）。
   */
  const generation = useRef(0);
  /** 正在进行的请求所属代次；没有时为 null。被作废的请求不会占着它。 */
  const inflight = useRef<number | null>(null);
  /** 当前视角。请求发出时按这里取，不用首次渲染时的值。 */
  const view = useRef({ conditions, workspaceScope, safeMode });
  view.current = { conditions, workspaceScope, safeMode };
  const lens = `${JSON.stringify(conditions)}\n${safeMode}\n${JSON.stringify(workspaceScope)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies(lens): 视角变了就作废在途请求
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
  /** 要记下的位置（见 storableAnchor）。 */
  const anchorToStore = useRef(() => anchor.current);
  /** Shift 单击的起点。 */
  const pivot = useRef<string | null>(null);
  const restoring = useRef(true);
  const settledTop = useRef<number | null>(null);
  const lastOpened = useRef<string | null>(null);
  const wasViewing = useRef(false);
  const layoutWidth = useRef(0);
  const { beforeReflow, motions, safeReflow, beforeBoxes, reflowMotion, slideMotion, trayMotion } = useReflowState();
  /** 先移走、后端还没做完的卡片（#290）；见 useWallPages。 */
  const pendingRemoval = useRef(new Set<string>());

  /** 原生滚轮监听读最新的渲染结果。 */
  const live = useRef({ layout: null as ReturnType<typeof masonry> | null, ids: [] as string[], density, previewDensity, onDensityPreview, onDensityCommit });
  /** 关闭后资料库按新视角送回的那一页已经到了：之后再来的成人图不算这次释放。 */
  const releasePage = useRef(false);
  const measureBeforeReflow = useMeasureBeforeReflow({ scroller, motions, safeReflow, reflowMotion, beforeReflow, beforeBoxes, live });

  /** 封印后按原型节奏移走飞走的图的那一帧（requestAnimationFrame id）；0 表示没有。 */
  const sealDrop = useRef(0);
  useEffect(() => () => cancelAnimationFrame(sealDrop.current), []);
  const loadMoreRef = useRef<() => void>(() => {});
  const selectAllRef = useRef<() => void>(() => {});
  useWallHandle({
    ref, measureBeforeReflow, setPreviewDensity, generation, inflight, loadMoreRef, selectAllRef, shownCards, pendingRemoval, setCards, setTotal,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies(density): 落下新密度后清掉预览
  useLayoutEffect(() => { setPreviewDensity(null); }, [density]);

  /**
   * Ctrl+滚轮缩放（#111）：光标下的那张图在预览后的布局里中心仍在光标的高度（列数会变，只锚纵向，#122）。只由下一次布局效果消费一次；
   * 滑条与键盘改密度不设它，仍以视口顶部的图为锚。
   */
  const zoomPin = useRef<{ id: string; pointerY: number } | null>(null);
  const zoom = useRef<ZoomState>({ value: null, timer: 0, count: createNotchCounter(), pin: null });
  const smoothRef = useRef<ReturnType<typeof createSmoothWheel> | null>(null);

  const returnTo = useViewerLeave({ viewerOpen, selected, lastOpened, wasViewing, smoothRef, cards: shown });

  const openTrayRef = useRef<(card: BrowserCard) => void>(() => {});
  const leaveTrayRef = useRef<() => void>(() => {});
  useCloseTrayOnTopbar(openSet, leaveTrayRef);
  const open = (card: BrowserCard) => {
    pivot.current = card.id;
    // 打开一摞是打开它的托盘（#418），不进查看器。
    if (card.set && !trayIds.has(card.id)) { openTrayRef.current(card); return; }
    lastOpened.current = card.id;
    onOpenImage(card);
  };

  const { pendingClick, lastPress, openById } = useDoubleClickGuard();
  openById.current = (id) => { const card = shown.find((c) => c.id === id); if (card) open(card); };


  // 界面缩放（#173）：图片大小是界面缩放 100% 时的 CSS 宽度，卡片按界面缩放缩小 CSS 宽度，
  // 屏幕上的宽度与每行张数不变。缩略图按卡片的 CSS 宽度乘实际的设备像素比请求。
  const uiScale = useUiScale();
  const dpr = useDevicePixelRatio();
  // 卡片里有文案：换界面语言时重建。
  const { t, i18n: { language } } = useTranslation("wall");
  const thumbnailPx = useMemo(
    () => Math.ceil((density / uiScale) * 1.5 * dpr),
    [density, uiScale, dpr],
  );
  // 换档位时卡片的缩略图地址跟着变（工作区的卡片在这里拼地址，#313），沿用的卡片元素要重建。
  const tier = thumbnailTier(thumbnailPx);

  useEffect(() => { onCardsChange?.(shown); }, [shown, onCardsChange]);
  useWallCaptureSources({ viewerOpen, scroller, cards: shown });
  const { loadMore } = useWallPages({
    cards, setCards, cursor, setCursor, setTotal, setError, generation, inflight, view, restoring, anchor, shownCards,
    measureBeforeReflow, onWorkspaceStatus, releasePage, reloadKey, loadMoreRef, workspaceScope, safeMode,
    pendingRemoval, stackSets, setStacked,
  });

  const { holdForDoubleClick } = useWidthSync({ holdReflow, settle, slideMotion, scroller, layoutWidth, measureBeforeReflow, setWidth, syncMount });

  const { revealed, arriving, fxHost, fx, releaseDue, book, releaseOnScreen } = useSealRelease({
    safeMode, cards, setCards, scroller, shownCards, live, safeReflow, sealDrop, measureBeforeReflow, viewerOpen, releasePage,
  });

  const ids = useMemo(() => shown.map((c) => c.id), [shown]);
  const layout = useMemo(
    () =>
      masonry(
        layoutItems(shown, uiScale),
        { width, target: (previewDensity ?? density) / uiScale, gap: GAP / uiScale, pad: PAD / uiScale, capRatio: CAP_RATIO },
        tray && { ...tray, pad: TRAY_PAD / uiScale },
      ),
    [shown, tray, width, density, previewDensity, uiScale],
  );

  useReflowAfterLayout({
    scroller, width, cards: shown, zoomPin, ids, layout, anchor, anchorToStore, storeKey, settledTop, cursor, restoring, beforeReflow, reflowMotion,
    beforeBoxes, syncMount, motions, slideMotion, trayMotion,
  });

  live.current = { layout, ids, density, previewDensity, onDensityPreview, onDensityCommit };

  useWallZoom({ scroller, zoom, live, smoothRef, zoomPin, setPreviewDensity, measureBeforeReflow });

  const scrollingTimer = useRef(0);
  useEffect(() => () => clearTimeout(scrollingTimer.current), []);
  /** 停手后才写本地存储（#109：不在每个滚动事件里同步写）；卸载与页面隐藏时立即写。 */
  const pendingSave = useRef<{ key: string; timer: number } | null>(null);
  anchorToStore.current = () => storableAnchor(anchor.current, shown, tray, trayIds);
  const flushSave = useCallback(() => {
    const pending = pendingSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSave.current = null;
    saveAnchor(pending.key, anchorToStore.current());
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => { window.removeEventListener("pagehide", flushSave); flushSave(); };
  }, [flushSave]);

  useReleaseLanding({ releaseDue, safeMode, cards: shown, layout, width, releasePage, fx, book, viewerOpen, releaseOnScreen });

  const onScroll = () => {
    const el = scroller.current!;
    syncMount(el);
    // 滚动中不拿起一摞（#418）。
    el.dataset.scrolling = "";
    clearTimeout(scrollingTimer.current);
    scrollingTimer.current = window.setTimeout(() => { delete el.dataset.scrolling; }, SCROLLING_MS);
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
  const mounted = useMountedCards({ layout, mount, position, viewerOpen, selected, lastOpened, beforeReflow, motions, trayMotion });

  useReturnFocus({ returnTo, scroller, position, layout, syncMount });

  /** 上次渲染的卡片元素，按 id；布局、选择、遮蔽都没变的卡片原样沿用。 */
  const renderedCards = useRef(new Map<string, { card: BrowserCard; box: Box; chosen: boolean; veiled: boolean; leaving: boolean; landing: boolean; tier: number; language: string; trayPage: number; veiledPages: string; node: ReactNode }>());
  useLayoutEffect(() => { renderedCards.current = nextRendered; });
  const cardHandlers = useRef<CardHandlers>(null!);
  usePrefetchThumbnails({ layout, mount, cards: shown, scrollDirection, thumbnailPx });

  const [menuTarget, setMenuTarget] = useState<WallMenuTarget | null>(null);
  const { openTray, closeTray } = useTrayMotion({
    scroller, layout, ids, shown, tray, openSet, setOpenSet, anchor, settledTop, beforeReflow, measureBeforeReflow, trayMotion, thumbnailPx,
    veiled: (card) => card.adult && (safeMode || !revealed.has(card.id)), safeMode,
  });
  const { click, clearOnBlankClick, targetMenu, cardKey, wallKey, dragStart, trayClick, leaveTray, pruneTray, toggle } = wallInteractions({
    ids, cards: shown, selected, onSelectionChange, pivot, lastPress, pendingClick, holdForDoubleClick, open, selectAllRef,
    setMenuTarget, menu, onCardCommand, scope, workspaceScope, trayIds, closeTray,
  });
  selectAllRef.current = () => onSelectionChange(new Set(ids));

  usePasteShortcut({ onPaste, viewerOpen, scroller });


  // 卡片的事件处理读这里的最新版本，沿用的卡片元素因此不会拿着旧的选择与回调。
  const switchTray = (card: BrowserCard) => { pruneTray(); openTray(card); };
  openTrayRef.current = switchTray;
  cardHandlers.current = {
    click, open, cardKey, dragStart,
    // 托盘开着时点别的格子的来源按钮：先关托盘（#418），这一格留在屏幕原处。
    inspect: onInspectSources && ((card) => { if (trayIds.size && !trayIds.has(card.id)) leaveTray(card.id); onInspectSources(card); }),
    openTray: (card) => { if (card.set) switchTray(card); },
    check: toggle,
  };
  leaveTrayRef.current = leaveTray;
  const nextRendered: typeof renderedCards.current = new Map();

  return (
    <ContextMenu.Root disabled={!menu} onOpenChange={(next) => { if (!next) setMenuTarget(null); }}>
    <ContextMenu.Trigger render={<div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}
      role="listbox" aria-label={t("label")} aria-multiselectable="true" tabIndex={-1} onKeyDown={wallKey} onClick={clearOnBlankClick}
      inert={viewerOpen}
      onContextMenuCapture={(e) => { if (menu) targetMenu(e); }} />}>
      {error && <p role="alert">{error}</p>}
      {total === 0 ? (
        <div className="wall-empty">
          <p>{searching ? t("empty.searching") : t(`empty.${scope.kind}`)}</p>
          {emptyAction?.(searching)}
        </div>
      ) : (
        <div className="wall-canvas" style={{ height: layout.height }}>
          {layout.tray && <div className="wall-tray" onClick={trayClick}
            style={{ left: `${layout.tray.x}px`, top: `${layout.tray.y}px`, width: `${layout.tray.w}px`, height: `${layout.tray.h}px` }} />}
          {mounted.map((i) => {
            const card = shown[i];
            const b = layout.boxes[i];
            const veiled = card.adult && (safeMode || !revealed.has(card.id));
            const veiledPages = veiledSheets(card, safeMode, revealed);
            // 安全模式下墙上的成人卡片只会是刚开启、等资料库确认的那些：影子已替它飞向封印书，
            // 原地不再留着遮蔽的图，只先占着位置，确认后其余卡片再补位（#154）。
            const leaving = card.adult && safeMode;
            const chosen = selected.has(card.id);
            const landing = arriving.has(card.id);
            // 托盘里的页记下页码（从 1 起）。
            const trayPage = tray && i >= tray.at && i < tray.at + tray.count ? i - tray.at + 1 : 0;
            // 没变的卡片沿用上次的元素，React 跳过整张卡片的比对（#109）。
            const kept = renderedCards.current.get(card.id);
            if (kept && kept.card === card && kept.box === b && kept.chosen === chosen && kept.veiled === veiled && kept.leaving === leaving && kept.landing === landing && kept.tier === tier && kept.language === language && kept.trayPage === trayPage && kept.veiledPages === veiledPages) {
              nextRendered.set(card.id, kept);
              return kept.node;
            }
            const node = wallCardNode({ card, thumbnailPx, b, landing, veiled, leaving, selected, workspaceScope, cardHandlers, lastOpened, trayPage, uiScale, veiledPages });
            nextRendered.set(card.id, { card, box: b, chosen, veiled, leaving, landing, tier, language, trayPage, veiledPages, node });
            return node;
          })}
          {/* 托盘关上时各页飞回一摞的影子（#418），由 useTrayMotion 直接放进来。 */}
          <div className="wall-ghosts" aria-hidden="true" />
        </div>
      )}
      {createPortal(<div className="fx-layer" ref={fxHost} aria-hidden="true" />, document.body)}
    </ContextMenu.Trigger>
    {menu && menuTarget && <MenuPopup label={menuTarget.kind === "blank" ? t("menu.blankLabel") : menuTarget.cards.length > 1 ? t("menu.cardsLabel", { count: menuTarget.cards.length }) : t("menu.cardLabel")} width={232}>
      {menu(menuTarget)}
    </MenuPopup>}
    </ContextMenu.Root>
  );
}
