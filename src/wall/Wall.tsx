import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
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
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import { captureAnchor, cardAt, masonry, resolveAnchor, visible, zoomScrollTop, type Anchor, type Box } from "./layout";
import { ZOOM_COMMIT_MS, createNotchCounter, zoomDensity } from "./zoom";
import { createSmoothWheel } from "./smoothWheel";
import { createPrefetcher, decodeThumbnail, mountWindow, prefetchOrder, type MountWindow } from "./prefetch";
import { MAX_GHOSTS, SEAL, SealFx, type FxArrival, type FxSource } from "../shell/sealfx";
import { reducedNow, useReducedMotion } from "../ui/reducedMotion";

// 常量沿用 #13 样稿（Wall.tsx）。
const GAP = 8;
const PAD = 12;
const OVERSCAN = 700;
/** 目标列宽（CSS 像素），样稿的默认密度。 */
const TARGET = 240;
/** 特别长的图整体缩小到列宽的 2.6 倍高，不裁切。 */
const CAP_RATIO = 2.6;
const PAGE = 500;
/** 滚动方向前方预取缩略图的距离（挂载范围之外，画布像素）与张数上限。 */
const PREFETCH_PX = 1600;
const PREFETCH_MAX = 48;
/** 滚动停手多久后把位置写进本地存储。 */
const SAVE_ANCHOR_MS = 250;
/**
 * 关闭安全模式后等资料库送回成人图的最长时间（毫秒）。超过了就不再从封印书飞出，
 * 回来的图照常淡出遮蔽：动画只跟着这一次切换，不挂在之后无关的重新浏览上。
 */
const RELEASE_WAIT = 1500;

/** 图片墙上拖出参考图时放进 dataTransfer 的类型，值为 JSON 数组的参考图 id。 */
export const DRAG_IMAGES = "application/x-kinshoko-images";
/**
 * 同一次拖动里每张图按图库列出的来源：JSON 对象 `{ 图库 id: 参考图 id[] }`。任何一个图库的文件夹都能
 * 接住拖来的图（ADR-0008），放进哪个库就取这张图在那个库里的来源。
 */
export const DRAG_IMAGE_SOURCES = "application/x-kinshoko-image-sources";

export type WallHandle = {
  previewDensity: (value: number | null) => void;
  /** 已知工作区变了：立刻作废在途响应，不等下一次 React 渲染。 */
  invalidate: () => void;
  /** 读下一页（查看器走过已读到的卡片时）；已在读或没有下一页时什么也不做。 */
  loadMore: () => void;
  /** 选中已读到的全部图（Ctrl+A，空白处菜单的“全选”）。 */
  selectAll: () => void;
};

/** 卡片上的快捷键（与右键菜单同一选择规则）：P 钉住、F1 进入查看器框选、Del 移到回收站、Ctrl+C 复制图片。 */
export type CardCommand = "pin" | "crop" | "trash" | "copy";

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
  /** Ctrl+V：从剪贴板导入（#105）。主窗口里焦点不在输入框、没有模态与查看器时都响应。 */
  onPaste?: () => void;
};

/**
 * 缩略图到达的标记直接写在节点上，不经 React 渲染（滚动时不为每张图重渲染）。
 * 重新挂载时已在浏览器缓存里的图直接显示，不再淡入；其余到达后淡入、盖住占位图。
 */
const markCachedThumbnail = (img: HTMLImageElement | null) => {
  if (!img) return;
  if (img.complete && img.naturalWidth > 0) img.dataset.loaded = "instant";
  // 卡片离开挂载范围时缩略图还没到：撤掉地址，浏览器放弃这次请求，不再替已经看不见的卡片取图（#123）。
  return () => {
    if (!img.complete) img.removeAttribute("src");
  };
};
const markThumbnailLoaded = (e: { currentTarget: HTMLImageElement }) => {
  if (!e.currentTarget.dataset.loaded) e.currentTarget.dataset.loaded = "fade";
};


/** 按键落在可输入的地方（输入框、文本框、可编辑区域）：Ctrl+V 是粘贴文字，不是导入。 */
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null);

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
 * 单击只选中这一张（详情面板跟着选择），双击或 Enter 打开查看器（#146，Eagle 与资源管理器的习惯）；
 * Ctrl 单击增减选择，Shift 单击选中一段，单击空白处清空选择；选中的图可以拖到文件夹上。
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
  const safeReflow = useRef<{ rects: Map<string, DOMRect>; at: number; delay: number; duration: number } | null>(null);
  /** 这一次重排的节奏；null 时是平常的 200 ms。 */
  const reflowMotion = useRef<{ at: number; delay: number; duration: number } | null>(null);

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
    const held = safeReflow.current;
    safeReflow.current = null;
    reflowMotion.current = held && performance.now() - held.at < RELEASE_WAIT ? held : null;
    beforeReflow.current = reflowMotion.current ? held!.rects : measured;
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
   * Ctrl+滚轮缩放（#111）：光标下的那张图在预览后的布局里中心仍在光标的高度（列数会变，只锚纵向，#122）。只由下一次布局效果消费一次；
   * 滑条与键盘改密度不设它，仍以视口顶部的图为锚。
   */
  const zoomPin = useRef<{ id: string; pointerY: number } | null>(null);
  const zoom = useRef({ value: null as number | null, timer: 0, count: createNotchCounter(), pin: null as { id: string; x: number; y: number } | null });
  const smoothRef = useRef<ReturnType<typeof createSmoothWheel> | null>(null);
  /** 原生滚轮监听读最新的渲染结果。 */
  const live = useRef({ layout: null as ReturnType<typeof masonry> | null, ids: [] as string[], density, previewDensity, onDensityPreview, onDensityCommit });

  useLayoutEffect(() => {
    // 打开查看器时停下滚轮惯性，返回时图片墙仍在打开时的位置。
    if (viewerOpen) smoothRef.current?.stop();
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
  const clearedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!workspaceKey) { clearedFor.current = null; return; }
    generation.current += 1;
    inflight.current = null;
    // 只是修订号前进（自动打标每写一张图一次，#142）或安全模式切换：保留旧卡片，等新的一页回来原地替换。
    // 安全模式开启的那一刻成人卡片已原地遮蔽，封印动画从它们飞出（#154），资料库确认后它们才离开。
    // 浏览范围变了才清空，不露出旧范围的内容。
    if (clearedFor.current === workspaceKey) return;
    clearedFor.current = workspaceKey;
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
      // 瀑布流追加时已有卡片的位置不变，不必量旧位置、起重排动画（#109）。
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
  }, [cards, cursor, thumbnailPx, reload, onWorkspaceStatus]);
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
      syncMount(el);
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => flushSync(sync));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureBeforeReflow, syncMount]);

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

  // ------------------------------------------------------------ 封印与释放（#27，原型 sealfx）
  // 开启：墙上看得见的成人图化成“影子”，原地模糊、缩小，再飞进封印书；关闭：书打开，资料库送回的
  // 成人图从书里飞回各自的位置，落地前卡片本身先藏着。影子在切换的那次提交里（绘制之前）就生成，
  // 卡片自身的遮蔽照旧在点下去的那一帧开始，动画不推迟、也不代替遮蔽。减少动态效果时没有影子。
  const fxHost = useRef<HTMLDivElement>(null);
  const fx = useRef<SealFx | null>(null);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());
  const lastSafe = useRef(safeMode);
  /** 等着回来的图飞出的截止时刻（performance.now）；0 表示没有。 */
  const releaseDue = useRef(0);
  const reduced = useReducedMotion();
  const landed = useCallback((id: string) => setArriving((s) => {
    if (!s.has(id)) return s;
    const n = new Set(s); n.delete(id); return n;
  }), []);
  useLayoutEffect(() => {
    const f = new SealFx(fxHost.current!);
    fx.current = f;
    return () => { fx.current = null; f.clear(); };
  }, []);
  useEffect(() => {
    if (!reduced) return;
    fx.current?.clear(); releaseDue.current = 0; setArriving(new Set());
  }, [reduced]);
  /** 视口里看得见的卡片。 */
  const onScreen = () => {
    const el = scroller.current;
    if (!el) return [];
    const view = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>(".card")].flatMap((node) => {
      const rect = node.getBoundingClientRect(), img = node.querySelector("img");
      const seen = rect.width > 0 && rect.height > 0 && rect.bottom >= view.top && rect.top <= view.bottom;
      return seen && img ? [{ id: node.dataset.id!, src: img.currentSrc || img.src, rect }] : [];
    });
  };
  /** 视口里看得见的成人卡片。 */
  const onScreenAdult = () => {
    const adult = new Set(cards.filter((c) => c.adult).map((c) => c.id));
    return onScreen().filter((c) => adult.has(c.id));
  };
  const book = () => document.querySelector(".seal-book")?.getBoundingClientRect();
  useLayoutEffect(() => {
    if (lastSafe.current === safeMode) return;
    lastSafe.current = safeMode;
    releaseDue.current = 0;
    safeReflow.current = null;
    const f = fx.current, b = book();
    if (!f || !b || viewerOpen || reducedNow()) {
      // 查看器盖着墙或减少动态效果：封印的图直接不见，放出的图直接在。
      f?.clear(); setArriving(new Set());
      return;
    }
    // 原型：封印时留下的卡片等影子起飞后（flyAt + 20）用 620 ms 补位；释放时 40 ms 后用 680 ms 让位。
    safeReflow.current = {
      rects: new Map(onScreen().map((c) => [c.id, c.rect])), at: performance.now(),
      delay: safeMode ? SEAL.flyAt + 20 : 40, duration: safeMode ? 620 : 680,
    };
    if (safeMode) {
      // 还在往外飞的影子先掉头（原型 Q111），再让墙上的成人图飞进书里。
      f.seal(onScreenAdult() satisfies FxSource[], b);
      setArriving(new Set());
    } else {
      releaseDue.current = performance.now() + RELEASE_WAIT;
    }
  }, [safeMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // 缩放：光标下那张图的中心放回光标的高度（列数会变，只锚纵向，#122）；随后以新布局里视口顶部的图为锚，提交时布局不变、位置不动。
      top = zoomScrollTop(layout, pinned, pin!.pointerY, el.clientHeight);
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
    const from = beforeReflow.current, safe = reflowMotion.current;
    beforeReflow.current = new Map();
    reflowMotion.current = null;
    const timing: KeyframeAnimationOptions = safe
      ? { duration: safe.duration, delay: Math.max(0, safe.at + safe.delay - performance.now()), easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" }
      : { duration: 200, easing: "cubic-bezier(0.2,0.8,0.2,1)" };
    if (from.size && !reducedNow()) {
      const targets = [...el.querySelectorAll<HTMLElement>(".card")].flatMap((node) => {
        const old = from.get(node.dataset.id!);
        return old ? [{ node, old, next: node.getBoundingClientRect() }] : [];
      });
      for (const { node, old, next } of targets) {
        if (!next.width || !next.height || typeof node.animate !== "function") continue;
        // 没有移动、没有变大小的卡片不起动画（#109：读下一页时已有卡片的位置不变）。
        if (Math.abs(old.left - next.left) < 0.5 && Math.abs(old.top - next.top) < 0.5 && Math.abs(old.width - next.width) < 0.5 && Math.abs(old.height - next.height) < 0.5) continue;
        const motion = node.animate([
          { transform: `translate(${old.left - next.left}px, ${old.top - next.top}px) scale(${old.width / next.width}, ${old.height / next.height})` },
          { transform: "none" },
        ], timing);
        motions.current.set(node.dataset.id!, motion);
        motion.onfinish = () => motions.current.delete(node.dataset.id!);
      }
    }
    syncMount(el);
  }, [layout, ids, width, cards.length, cursor, syncMount]);

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
    // 鼠标滚轮插值与惯性（#109）；Ctrl 的滚轮留给下面的缩放。
    const smooth = createSmoothWheel(el, { limit: () => Math.max(0, (live.current.layout?.height ?? 0) - el.clientHeight) });
    smoothRef.current = smooth;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      smooth.stop();
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
      smooth.dispose();
      smoothRef.current = null;
      // 缩放停手前离开（换范围重建图片墙）也落下画师选的大小。
      if (z.value !== null) commit();
    };
  }, [measureBeforeReflow]);

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

  // 关闭安全模式后，资料库送回的成人图排好了位置：它们就是从书里飞出的落点。
  useLayoutEffect(() => {
    const due = releaseDue.current, f = fx.current, b = book();
    if (!due || safeMode || !cards.length || !width) return;
    releaseDue.current = 0;
    if (!f || !b || performance.now() > due || viewerOpen || reducedNow()) return;
    const arrivals: FxArrival[] = onScreenAdult().slice(0, MAX_GHOSTS).map(({ id, src, rect }) => ({
      id, src, w: rect.width, h: rect.height,
      target: () => {
        const r = scroller.current?.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.getBoundingClientRect();
        return r && r.width > 0 ? r : null;
      },
    }));
    if (!arrivals.length) return;
    setArriving(new Set(arrivals.map((a) => a.id)));
    f.release(arrivals, b, landed);
  }, [cards, layout, width]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [layout, mount, position, viewerOpen]);

  // 缩略图按滚动方向预取，离挂载范围近的先取；挂载范围变化时更新（#109）。
  const prefetcher = useRef<ReturnType<typeof createPrefetcher> | null>(null);
  /** 上次渲染的卡片元素，按 id；布局、选择、遮蔽都没变的卡片原样沿用。 */
  const renderedCards = useRef(new Map<string, { card: BrowserCard; box: Box; chosen: boolean; veiled: boolean; landing: boolean; node: ReactNode }>());
  useLayoutEffect(() => { renderedCards.current = nextRendered; });
  const cardHandlers = useRef<{
    select: (id: string, e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">) => void;
    open: (card: BrowserCard) => void;
    cardKey: (card: BrowserCard, e: KeyboardEvent<HTMLElement>) => void;
    dragStart: (id: string, e: DragEvent) => void;
    inspect?: (card: WorkspaceCard) => void;
  }>(null!);
  useEffect(() => {
    const prefetch = createPrefetcher({ load: decodeThumbnail });
    prefetcher.current = prefetch;
    return () => { prefetch.dispose(); prefetcher.current = null; };
  }, []);
  useEffect(() => {
    if (!cards.length || mount.bottom <= mount.top) return;
    const order = prefetchOrder(layout, mount, scrollDirection.current, PREFETCH_PX).slice(0, PREFETCH_MAX);
    prefetcher.current?.want(order.map((i) => thumbnailUrl(cards[i].thumbnail)));
  }, [layout, mount, cards]);

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
  /** 单击空白处清空选择（资源管理器的习惯）；按着修饰键时不动，落在滚动条上的不算。 */
  const clearOnBlankClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || !selected.size) return;
    if ((e.target as Element).closest?.(".card, .card-sources")) return;
    const el = e.currentTarget;
    if (e.clientX - el.getBoundingClientRect().left >= el.clientWidth) return;
    onSelectionChange(new Set());
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
    const chord = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
    if (chord && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectAllRef.current();
    } else if (chord && e.key.toLowerCase() === "c" && onCardCommand) {
      // 复制：焦点在卡片上时按右键的同一选择规则；否则是当前选择。多张由调用方提示一次只能复制一张。
      const node = (e.target as Element).closest?.<HTMLElement>(".card");
      const acted = node?.dataset.id ? actOn(node.dataset.id) : cards.filter((c) => selected.has(c.id));
      if (!acted.length) return;
      e.preventDefault();
      const rect = (node ?? e.currentTarget).getBoundingClientRect();
      onCardCommand("copy", acted, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else if (isMenuKey(e) && e.target === e.currentTarget && menu) {
      e.preventDefault();
      openMenuAt(e.currentTarget);
    }
  };

  const paste = useRef({ onPaste, viewerOpen });
  paste.current = { onPaste, viewerOpen };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "v" || e.defaultPrevented) return;
      const { onPaste, viewerOpen } = paste.current;
      const el = scroller.current;
      if (!onPaste || !el || viewerOpen || modalOpen() || el.closest("[hidden], [inert]") || editable(e.target)) return;
      e.preventDefault();
      onPaste();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
    const bySource: Record<string, string[]> = {};
    for (const source of dragged.flatMap((id) => cards.find((c) => c.id === id)?.sources ?? [])) {
      if (!source.unavailable) (bySource[source.libraryId] ??= []).push(source.imageId);
    }
    e.dataTransfer.setData(DRAG_IMAGE_SOURCES, JSON.stringify(bySource));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  // 卡片的事件处理读这里的最新版本，沿用的卡片元素因此不会拿着旧的选择与回调。
  cardHandlers.current = { select, open, cardKey, dragStart, inspect: onInspectSources };
  const nextRendered: typeof renderedCards.current = new Map();

  return (
    <ContextMenu.Root disabled={!menu} onOpenChange={(next) => { if (!next) setMenuTarget(null); }}>
    <ContextMenu.Trigger render={<div className="wall" ref={scroller} onScroll={onScroll} data-total={total ?? undefined}
      role="listbox" aria-label="图片墙" aria-multiselectable="true" tabIndex={-1} onKeyDown={wallKey} onClick={clearOnBlankClick}
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
            const chosen = selected.has(card.id);
            const landing = arriving.has(card.id);
            // 没变的卡片沿用上次的元素，React 跳过整张卡片的比对（#109）。
            const kept = renderedCards.current.get(card.id);
            if (kept && kept.card === card && kept.box === b && kept.chosen === chosen && kept.veiled === veiled && kept.landing === landing) {
              nextRendered.set(card.id, kept);
              return kept.node;
            }
            const sources = card.libraryId && card.imageId ? card.sources ?? [] : [];
            const node = (
              <Fragment key={card.id}>
              <div
                className={landing ? "card is-arriving" : "card"}
                data-id={card.id}
                aria-selected={selected.has(card.id)}
                role="option"
                tabIndex={0}
                data-veiled={veiled}
                draggable={!workspaceScope || workspaceScope.kind === "library" || (card.sources?.some((source) => !source.unavailable) ?? false)}
                onClick={(e) => cardHandlers.current.select(card.id, e)}
                onDoubleClick={() => cardHandlers.current.open(card)}
                onKeyDown={(e) => cardHandlers.current.cardKey(card, e)}
                onDragStart={(e) => cardHandlers.current.dragStart(card.id, e)}
                style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }}
              >
                <img src={thumbnailUrl(card.thumbnail)} alt="参考图" decoding="async" draggable={false}
                  ref={markCachedThumbnail} onLoad={markThumbnailLoaded} />
                {/* 占位图（#110）：缩略图到达前放大模糊显示；遮蔽中的图不露出它的色彩。 */}
                {card.placeholder && !veiled && <div className="card-placeholder" aria-hidden="true"
                  style={{ backgroundImage: `url("${card.placeholder}")` }} />}
              </div>
              {/* 来源按钮是卡片选项的兄弟，不在选项里：选项内不放可聚焦的子元素。 */}
              {sources.length > 0 && <button type="button" className={`card-sources${sources.length === 1 ? " is-single" : ""}`} data-card={card.id}
                aria-label={sources.length >= 2 ? `在 ${sources.length} 个图库 · 查看详情` : `来源：${sources[0].libraryName} · 查看详情`}
                title={sources.length >= 2 ? `在 ${sources.length} 个图库` : `在「${sources[0].libraryName}」`}
                style={{ left: `${b.x + b.w - 8}px`, top: `${b.y + b.h - 8}px` }}
                onClick={(e) => { e.stopPropagation(); lastOpened.current = card.id; cardHandlers.current.inspect?.(card as WorkspaceCard); }}
                onKeyDown={(e) => e.stopPropagation()}><Layers size={11} aria-hidden="true" />{sources.length >= 2 && `${sources.length} 处`}</button>}
              </Fragment>
            );
            nextRendered.set(card.id, { card, box: b, chosen, veiled, landing, node });
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
