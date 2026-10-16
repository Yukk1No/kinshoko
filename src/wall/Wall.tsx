import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { Layers } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MenuPopup } from "../ui/Menu";
import type { WallMenuTarget } from "./WallMenu";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { ImageCard } from "../bindings/ImageCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowsePage } from "../bindings/BrowsePage";
import type { WorkspacePage } from "../bindings/WorkspacePage";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { browse, workspaceBrowse, isCursorExpired, isLensChanged, thumbnailUrl } from "../ipc";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { modalOpen } from "../ui/modal";
import { captureAnchor, cardAt, masonry, resolveAnchor, visible, type Anchor } from "./layout";
import { ZOOM_COMMIT_MS, createNotchCounter, zoomDensity } from "./zoom";

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

export type WallHandle = {
  previewDensity: (value: number | null) => void;
  /** 已知工作区变了：立刻作废在途响应，不等下一次 React 渲染。 */
  invalidate: () => void;
  /** 读下一页（查看器走过已读到的卡片时）；已在读或没有下一页时什么也不做。 */
  loadMore: () => void;
  /** 选中已读到的全部图（Ctrl+A，空白处菜单的“全选”）。 */
  selectAll: () => void;
};

/** 卡片上的快捷键（与右键菜单同一选择规则）：P 钉住、F1 进入查看器框选、Del 移到回收站。 */
export type CardCommand = "pin" | "crop" | "trash";

export type BrowserCard = ImageCard & Partial<Pick<WorkspaceCard, "libraryId" | "imageId" | "sources">>;

type Props = {
  workspaceScope?: WorkspaceScope;
  onInspectSources?: (card: WorkspaceCard) => void;
  onCardsChange?: (cards: BrowserCard[]) => void;
  /** 只有当前请求已完整接受的工作区快照，才能成为父界面的已知状态。 */
  onWorkspaceStatus?: (status: WorkspaceStatus, cards: BrowserCard[]) => void;
  /** Artist-selected target card width; preview stays local until the slider commits. */
  density?: number;
  /** Ctrl+滚轮缩放中的本地预览（#111），让图片大小滑条跟着走；null 为撤掉预览。 */
  onDensityPreview?: (value: number | null) => void;
  /** Ctrl+滚轮最后一格后 220 ms 提交的图片大小，与滑条提交同一个值。 */
  onDensityCommit?: (value: number) => void;
  onTotalChange?: (count: number | null) => void;
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
  onOpenImage: (card: BrowserCard) => void;
  viewerOpen: boolean;
  /** 右键菜单的内容（#102）；不给出时图片墙没有右键菜单。 */
  menu?: (target: WallMenuTarget) => ReactNode;
  onCardCommand?: (command: CardCommand, cards: BrowserCard[], point: { x: number; y: number }) => void;
};

/** 菜单键或 Shift+F10：用键盘打开右键菜单。 */
const isMenuKey = (e: Pick<KeyboardEvent, "key" | "shiftKey">) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** 在元素中心派发一次 contextmenu，键盘打开的菜单与右键走同一路径。 */
function openMenuAt(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  node.dispatchEvent(new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
}

/** 每个范围各自记住位置。“全部”沿用 #44 的键。 */
export const scopeKey = (scope: BrowseScope) =>
  (scope.kind === "folder" || scope.kind === "folderTree") ? `${scope.kind}.${scope.id}` : scope.kind;

const anchorKey = (libraryId: string, scope: BrowseScope) =>
  scope.kind === "all"
    ? `kinshoko.wall.anchor.${libraryId}`
    : `kinshoko.wall.anchor.${libraryId}.${scopeKey(scope)}`;

const EMPTY: Record<BrowseScope["kind"], string> = {
  all: "图库里还没有参考图。点右上角的“导入”，或直接拖进窗口。",
  folder: "这个文件夹里还没有参考图。选中图片后点“放入”，或把图片拖到侧栏的文件夹上。",
  folderTree: "这个文件夹及其子文件夹还没有参考图。",
  unassigned: "这个图库没有未归类的参考图。",
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
 * 单击打开（沿用认可原型），Ctrl 单击增减选择，Shift 单击选中一段；选中的图可以拖到文件夹上。
 * 换范围或条件时由调用方换 key 重建。查找结果不记住位置，新的查找从顶部看起。
 */
export const Wall = forwardRef<WallHandle, Props>(function Wall({
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
  selected,
  onSelectionChange,
  onOpenImage,
  viewerOpen,
  menu,
  onCardCommand,
}, ref) {
  const searching = conditions.conditions.length > 0;
  const storeKey = searching ? null : workspaceScope ? `kinshoko.wall.workspace.${JSON.stringify(workspaceScope)}` : anchorKey(libraryId, scope);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [previewDensity, setPreviewDensity] = useState<number | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [cards, setCards] = useState<BrowserCard[]>([]);
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
  const loadMoreRef = useRef<() => void>(() => {});
  const selectAllRef = useRef<() => void>(() => {});
  useImperativeHandle(ref, () => ({
    previewDensity(value) { measureBeforeReflow(); setPreviewDensity(value); },
    invalidate() { generation.current += 1; inflight.current = null; },
    loadMore() { loadMoreRef.current(); },
    selectAll() { selectAllRef.current(); },
  }), [measureBeforeReflow]);
  useLayoutEffect(() => { setPreviewDensity(null); }, [density]);

  /**
   * Ctrl+滚轮缩放（#111）：光标下的那张图在预览后的布局里中心仍在光标下。只由下一次布局效果消费一次；
   * 滑条与键盘改密度不设它，仍以视口顶部的图为锚。
   */
  const zoomPin = useRef<{ id: string; pointerY: number } | null>(null);
  const zoom = useRef({ value: null as number | null, timer: 0, count: createNotchCounter(), pin: null as { id: string; x: number; y: number } | null });
  /** 原生滚轮监听读最新的渲染结果。 */
  const live = useRef({ layout: null as ReturnType<typeof masonry> | null, ids: [] as string[], density, previewDensity, onDensityPreview, onDensityCommit });

  useLayoutEffect(() => {
    if (wasViewing.current && !viewerOpen && lastOpened.current) {
      const card = scroller.current?.querySelector<HTMLElement>(`[data-id="${lastOpened.current}"]`);
      card?.focus({ preventScroll: true });
    }
    wasViewing.current = viewerOpen;
  }, [viewerOpen]);

  const open = (card: BrowserCard) => {
    pivot.current = card.id;
    lastOpened.current = card.id;
    onOpenImage(card);
  };

  const thumbnailPx = useMemo(
    () => Math.ceil(density * 1.5 * (window.devicePixelRatio || 1)),
    [density],
  );

  useEffect(() => { onCardsChange?.(cards); }, [cards, onCardsChange]);
  // Keyed by value: re-selecting the same range creates a new but equal object. Clearing on that
  // identity change emptied the wall without the reload below ever running again (T20 r5/r6).
  const workspaceKey = workspaceScope ? JSON.stringify(workspaceScope) : null;
  useLayoutEffect(() => {
    if (!workspaceKey) return;
    generation.current += 1;
    inflight.current = null;
    // Emptying the canvas clamps browser scrollTop. Preserve the user's anchor
    // until the new authorized page restores it.
    restoring.current = true;
    setCards([]);
    setTotal(null);
    setCursor(null);
  }, [reloadKey, safeMode, workspaceKey]);
  useCaptureSources(() => {
    // 模态盖住图片墙时不登记来源；行内浮层（role="dialog" 的查找浮层等）不挡。
    if (viewerOpen || !scroller.current || modalOpen()) return null;
    return [...scroller.current.querySelectorAll<HTMLImageElement>(".card img")].flatMap((image) => {
      const node = image.closest<HTMLElement>(".card")!;
      const card = cards.find((item) => item.id === node.dataset.id);
      if (!card || node.dataset.veiled === "true") return [];
      const reference = captureImage(image, scroller.current!, card.libraryId ?? libraryId, card.imageId ?? card.id, card.width, card.height);
      return reference ? [reference] : [];
    });
  }, 10);
  const loaded = useRef(0);
  loaded.current = cards.length;

  /** 从头取至少 want 张，一次替换，避免列表闪空。之前还在路上的请求一律作废。 */
  const reload = useCallback(
    async (want: number) => {
      const gen = ++generation.current;
      inflight.current = gen;
      const { libraryId, scope, conditions, workspaceScope, safeMode } = view.current;
      const current = () => gen === generation.current;
      try {
        // 取到一半结果集变了（游标过期）：从头再取，最多几次，仍不稳定才报错。
        for (let attempt = 0; ; attempt++) {
          const next: BrowserCard[] = [];
          let after: string | null = null;
          let count = 0;
          let acceptedStatus: WorkspaceStatus | null = null;
          try {
            do {
              const result: { page: BrowsePage | WorkspacePage; status: WorkspaceStatus | null } = workspaceScope
                ? await workspaceBrowse({ scope: workspaceScope, conditions, cursor: after, limit: PAGE, thumbnailPx }, safeMode).then(page => ({ page, status: page.status }))
                : { page: await browse(libraryId, { scope, conditions, cursor: after, limit: PAGE, thumbnailPx }), status: null };
              const page = result.page;
              if (!current()) return;
              acceptedStatus = result.status;
              next.push(...page.cards);
              after = page.nextCursor;
              count = page.total;
              // 恢复位置时一直取到锚定的那张图为止。
              const target = restoring.current ? anchor.current?.id : undefined;
              if (next.length >= want && !(target && !next.some((c) => c.id === target))) break;
            } while (after);
          } catch (e) {
            if (current() && isCursorExpired(e) && attempt < 3) continue;
            throw e;
          }
          measureBeforeReflow();
          if (acceptedStatus) onWorkspaceStatus?.(acceptedStatus, next);
          setCards(next);
          setCursor(after);
          setTotal(count);
          setError(null);
          return;
        }
      } catch (e) {
        if (current()) setError(String(e));
      } finally {
        if (inflight.current === gen) inflight.current = null;
      }
    },
    [thumbnailPx, measureBeforeReflow, onWorkspaceStatus],
  );

  const loadMore = useCallback(async () => {
    if (inflight.current !== null || !cursor) return;
    const gen = generation.current;
    inflight.current = gen;
    const { libraryId, scope, conditions, workspaceScope, safeMode } = view.current;
    let expired = false;
    try {
      const result: { page: BrowsePage | WorkspacePage; status: WorkspaceStatus | null } = workspaceScope
        ? await workspaceBrowse({ scope: workspaceScope, conditions, cursor, limit: PAGE, thumbnailPx }, safeMode).then(page => ({ page, status: page.status }))
        : { page: await browse(libraryId, { scope, conditions, cursor, limit: PAGE, thumbnailPx }), status: null };
      const page = result.page;
      if (gen !== generation.current) return;
      const next = [...cards, ...page.cards];
      if (result.status) onWorkspaceStatus?.(result.status, next);
      measureBeforeReflow();
      setCards(next);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      // 结果集变了，接着翻会遗漏或重复：从第一页重读，保持正在看的位置。
      if (isCursorExpired(e)) expired = true;
      else if (!isLensChanged(e)) setError(String(e));
    } finally {
      if (inflight.current === gen) inflight.current = null;
    }
    if (expired) void reload(Math.max(loaded.current, PAGE));
  }, [cards, cursor, thumbnailPx, measureBeforeReflow, reload, onWorkspaceStatus]);
  loadMoreRef.current = () => { void loadMore(); };
  useEffect(() => {
    void reload(Math.max(loaded.current, PAGE));
  }, [reload, reloadKey]);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      if (el.clientWidth !== layoutWidth.current) {
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
  }, [measureBeforeReflow]);

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
        { width, target: previewDensity ?? density, gap: GAP, pad: PAD, capRatio: CAP_RATIO },
      ),
    [cards, width, density, previewDensity],
  );

  // 布局变化（宽度、新的一批卡片）后把锚定的图放回原来的位置。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !width || !cards.length) return;
    const pin = zoomPin.current;
    zoomPin.current = null;
    const pinned = pin ? ids.indexOf(pin.id) : -1;
    let top: number | null;
    if (pinned >= 0) {
      // 缩放：光标下那张图的中心放回光标下；随后以新布局里视口顶部的图为锚，提交时布局不变、位置不动。
      const b = layout.boxes[pinned];
      top = Math.max(0, Math.min(b.y + b.h / 2 - pin!.pointerY, layout.height - el.clientHeight));
      anchor.current = captureAnchor(layout, ids, top, el.clientHeight);
      if (storeKey) saveAnchor(storeKey, anchor.current);
    } else {
      top = resolveAnchor(layout, ids, anchor.current);
    }
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

  live.current = { layout, ids, density, previewDensity, onDensityPreview, onDensityCommit };

  // Ctrl+滚轮缩放（#111）。React 的 onWheel 是被动监听，不能阻止 WebView 的页面缩放，所以手动加。
  useEffect(() => {
    const el = scroller.current!;
    const z = zoom.current;
    const commit = () => {
      const value = z.value;
      clearTimeout(z.timer);
      z.value = null;
      z.pin = null;
      z.count = createNotchCounter();
      if (value === null) return;
      const { density, onDensityPreview, onDensityCommit } = live.current;
      if (value === density) {
        setPreviewDensity(null);
        onDensityPreview?.(null);
      } else {
        onDensityCommit?.(value);
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const notches = z.count(e);
      if (!notches) return;
      clearTimeout(z.timer);
      z.timer = window.setTimeout(commit, ZOOM_COMMIT_MS);
      const { layout, ids, density, previewDensity, onDensityPreview } = live.current;
      const from = z.value ?? previewDensity ?? density;
      const next = zoomDensity(from, notches);
      if (next === from || !layout) return;
      z.value = next;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // 同一次连续缩放里光标没动就一直锚同一张图，不因落到缝隙而换图。
      if (!z.pin || Math.hypot(z.pin.x - x, z.pin.y - y) > 2) {
        const i = cardAt(layout, x + el.scrollLeft, y + el.scrollTop);
        z.pin = i >= 0 ? { id: ids[i], x, y } : null;
      }
      zoomPin.current = z.pin ? { id: z.pin.id, pointerY: y } : null;
      measureBeforeReflow();
      flushSync(() => setPreviewDensity(next));
      onDensityPreview?.(next);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      // 缩放停手前离开（换范围重建图片墙）也落下画师选的大小。
      if (z.value !== null) commit();
    };
  }, [measureBeforeReflow]);

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

  selectAllRef.current = () => onSelectionChange(new Set(ids));

  /**
   * 右键（或快捷键）作用的卡片：右键已选中的卡片时是整组选择（按图片墙顺序）；
   * 右键未选中的卡片时选择改为只有这一张。
   */
  const actOn = (id: string): BrowserCard[] => {
    if (selected.has(id)) return cards.filter((c) => selected.has(c.id));
    pivot.current = id;
    onSelectionChange(new Set([id]));
    return cards.filter((c) => c.id === id);
  };
  const [menuTarget, setMenuTarget] = useState<WallMenuTarget | null>(null);
  const targetMenu = (e: MouseEvent) => {
    const point = { x: e.clientX, y: e.clientY };
    const node = (e.target as Element).closest?.<HTMLElement>(".card, .card-sources");
    const id = node?.dataset.id ?? node?.dataset.card;
    const acted = id ? actOn(id) : [];
    setMenuTarget(acted.length ? { kind: "cards", cards: acted, point } : { kind: "blank", point });
  };
  const cardKey = (card: BrowserCard, e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") { e.preventDefault(); open(card); return; }
    if (e.key === " ") { e.preventDefault(); select(card.id, e); return; }
    if (isMenuKey(e)) { e.preventDefault(); e.stopPropagation(); if (menu) openMenuAt(e.currentTarget); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const command: CardCommand | null = e.key === "p" || e.key === "P" ? "pin" : e.key === "F1" ? "crop" : e.key === "Delete" && scope.kind !== "trash" ? "trash" : null;
    if (!command || !onCardCommand) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const acted = actOn(card.id);
    onCardCommand(command, command === "crop" ? acted.filter((c) => c.id === card.id) : acted, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };
  const wallKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllRef.current();
    } else if (isMenuKey(e) && e.target === e.currentTarget && menu) {
      e.preventDefault();
      openMenuAt(e.currentTarget);
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
    const sourceIds = workspaceScope?.kind === "library"
      ? dragged.flatMap((id) => cards.find((c) => c.id === id)?.sources?.filter((s) => s.libraryId === workspaceScope.libraryId && !s.unavailable).map((s) => s.imageId) ?? [])
      : dragged;
    e.dataTransfer.setData(DRAG_IMAGES, JSON.stringify(sourceIds));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  return (
    <ContextMenu.Root disabled={!menu} onOpenChange={(next) => { if (!next) setMenuTarget(null); }}>
    <ContextMenu.Trigger render={<div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}
      role="listbox" aria-label="图片墙" aria-multiselectable="true" tabIndex={-1} onKeyDown={wallKey}
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
            const sources = card.libraryId && card.imageId ? card.sources ?? [] : [];
            return (
              <Fragment key={card.id}>
              <div
                className="card"
                data-id={card.id}
                aria-selected={selected.has(card.id)}
                role="option"
                tabIndex={0}
                data-veiled={veiled}
                draggable={!workspaceScope || workspaceScope.kind === "library"}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey) select(card.id, e);
                  else open(card);
                }}
                onDoubleClick={() => open(card)}
                onKeyDown={(e) => cardKey(card, e)}
                onDragStart={(e) => dragStart(card.id, e)}
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }}
              >
                <img src={thumbnailUrl(card.thumbnail)} alt="参考图" decoding="async" draggable={false} />
              </div>
              {/* 来源按钮是卡片选项的兄弟，不在选项里：选项内不放可聚焦的子元素。 */}
              {sources.length > 0 && <button type="button" className={`card-sources${sources.length === 1 ? " is-single" : ""}`} data-card={card.id}
                aria-label={sources.length >= 2 ? `在 ${sources.length} 个图库 · 查看详情` : `来源：${sources[0].libraryName} · 查看详情`}
                title={sources.length >= 2 ? `在 ${sources.length} 个图库` : `在「${sources[0].libraryName}」`}
                style={{ left: `${b.x + b.w - 8}px`, top: `${b.y + b.h - 8}px` }}
                onClick={(e) => { e.stopPropagation(); lastOpened.current = card.id; onInspectSources?.(card as WorkspaceCard); }}
                onKeyDown={(e) => e.stopPropagation()}><Layers size={11} aria-hidden="true" />{sources.length >= 2 && `${sources.length} 处`}</button>}
              </Fragment>
            );
          })}
        </div>
      )}
    </ContextMenu.Trigger>
    {menu && menuTarget && <MenuPopup label={menuTarget.kind === "blank" ? "图片墙菜单" : menuTarget.cards.length > 1 ? `${menuTarget.cards.length} 张参考图的菜单` : "参考图菜单"} width={232}>
      {menu(menuTarget)}
    </MenuPopup>}
    </ContextMenu.Root>
  );
});
