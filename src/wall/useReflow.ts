// 重排的滑动动画：重排前量下卡片位置；布局变化后把锚定的图放回原处，卡片从旧位置滑到新位置。
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { flushSync } from "react-dom";
import { reducedNow } from "../ui/reducedMotion";
import { doubleClickSettings } from "./doubleClick";
import { captureAnchor, resolveAnchor, zoomScrollTop, type Anchor, type masonry } from "./layout";
import { RELEASE_WAIT, saveAnchor, type LayoutSnapshot } from "./wallShared";
import type { PanelSlide } from "../shell/usePanelSlide";

type SafeReflow = {
  rects: Map<string, DOMRect>; boxes: LayoutSnapshot; at: number; delay: number; duration: number;
  /** 存下之后卡片又被别的重排挪过（例如墙变宽）：起点按用时量到的位置，不用存下的。 */
  moved?: boolean;
};
type Motion = { at: number; delay: number; duration: number };

/** 重排动画在各 hook 之间共用的状态；卸载时取消还在滑的卡片。 */
export function useReflowState() {
  const beforeReflow = useRef(new Map<string, DOMRect>());
  const motions = useRef(new Map<string, Animation>());
  /**
   * 安全模式切换那一刻量下的卡片位置。资料库按新视角送回卡片后，留下的卡片从这里滑到新位置，
   * 节奏按原型的封印／释放重排（从点下去的时刻算起）。
   */
  const safeReflow = useRef<SafeReflow | null>(null);
  /** 封印／释放重排前的布局：点下去时不在视口里的卡片，从这里算出起点（#154）。 */
  const beforeBoxes = useRef<LayoutSnapshot | null>(null);
  /** 这一次重排的节奏；null 时是平常的 200 ms。 */
  const reflowMotion = useRef<Motion | null>(null);
  /** 这一次重排跟着面板过渡走（settle）：卡片动画用面板的时长、缓动与起点。 */
  const slideMotion = useRef<PanelSlide | null>(null);
  useEffect(() => () => { motions.current.forEach((motion) => motion.cancel()); }, []);
  return { beforeReflow, motions, safeReflow, beforeBoxes, reflowMotion, slideMotion };
}

export function useMeasureBeforeReflow({ scroller, motions, safeReflow, reflowMotion, beforeReflow, beforeBoxes, live }: {
  scroller: MutableRefObject<HTMLDivElement | null>;
  motions: MutableRefObject<Map<string, Animation>>;
  safeReflow: MutableRefObject<SafeReflow | null>;
  reflowMotion: MutableRefObject<Motion | null>;
  beforeReflow: MutableRefObject<Map<string, DOMRect>>;
  beforeBoxes: MutableRefObject<LayoutSnapshot | null>;
  live: MutableRefObject<{ layout: ReturnType<typeof masonry> | null; ids: string[] }>;
}) {
  /**
   * 重排前量下卡片位置。`keepSafe`：这次重排与安全模式切换无关（墙的宽度变了，例如详情面板随选择清空而收起），
   * 按平常的节奏滑，切换时存下的节奏留给资料库送回卡片或封印让位那一次，起点换成现在的位置。
   */
  return useCallback((keepSafe = false) => {
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
    // 还在滑的卡片（例如墙变宽的那段）量到的是动画中途的位置：这时存下的位置已经过时。
    const moving = motions.current.size > 0;
    motions.current.forEach((motion) => motion.cancel());
    motions.current.clear();
    const held = safeReflow.current;
    if (keepSafe) {
      if (held) held.moved = true;
      reflowMotion.current = null;
      beforeReflow.current = measured;
      beforeBoxes.current = null;
      return;
    }
    safeReflow.current = null;
    reflowMotion.current = held && performance.now() - held.at < RELEASE_WAIT ? held : null;
    if (reflowMotion.current && (held!.moved || moving)) {
      const { layout: now, ids: shown } = live.current;
      beforeReflow.current = measured;
      beforeBoxes.current = { boxes: new Map(now ? shown.map((id, i) => [id, now.boxes[i]]) : []), scrollTop: el.scrollTop };
      return;
    }
    beforeReflow.current = reflowMotion.current ? held!.rects : measured;
    beforeBoxes.current = reflowMotion.current ? held!.boxes : null;
  }, []);
}

export function useReflowAfterLayout({
  scroller, width, cards, zoomPin, ids, layout, anchor, storeKey, settledTop, cursor, restoring, beforeReflow, reflowMotion,
  beforeBoxes, syncMount, motions, slideMotion,
}: {
  scroller: MutableRefObject<HTMLDivElement | null>;
  width: number;
  cards: readonly unknown[];
  zoomPin: MutableRefObject<{ id: string; pointerY: number } | null>;
  ids: string[];
  layout: ReturnType<typeof masonry>;
  anchor: MutableRefObject<Anchor | null>;
  storeKey: string | null;
  settledTop: MutableRefObject<number | null>;
  cursor: string | null;
  restoring: MutableRefObject<boolean>;
  beforeReflow: MutableRefObject<Map<string, DOMRect>>;
  reflowMotion: MutableRefObject<Motion | null>;
  beforeBoxes: MutableRefObject<LayoutSnapshot | null>;
  syncMount: (el: HTMLElement) => void;
  motions: MutableRefObject<Map<string, Animation>>;
  slideMotion: MutableRefObject<PanelSlide | null>;
}) {
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
    const from = beforeReflow.current, safe = reflowMotion.current, fromBoxes = beforeBoxes.current, slide = slideMotion.current;
    slideMotion.current = null;
    beforeReflow.current = new Map();
    reflowMotion.current = null;
    beforeBoxes.current = null;
    /** 点下去时不在视口里、没有量到矩形的卡片：按前后两次布局的位置差（含滚动差）推出它当时在哪。 */
    const index = fromBoxes ? new Map(ids.map((id, i) => [id, i])) : null;
    const derive = (id: string, next: DOMRect) => {
      const prev = fromBoxes?.boxes.get(id), i = index?.get(id), cur = i === undefined ? undefined : layout.boxes[i];
      if (!prev || !cur || !cur.w || !cur.h) return undefined;
      return new DOMRect(next.left + prev.x - cur.x, next.top + (prev.y - fromBoxes!.scrollTop) - (cur.y - el.scrollTop),
        next.width * prev.w / cur.w, next.height * prev.h / cur.h);
    };
    // 先读（挂载范围、各卡片矩形），再起滑动动画：起动画之后再读布局会再强制排一次版（#176）。
    syncMount(el);
    const timing: KeyframeAnimationOptions = slide
      ? { duration: slide.duration, easing: slide.easing }
      : safe
      ? { duration: safe.duration, delay: Math.max(0, safe.at + safe.delay - performance.now()), easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" }
      : { duration: 200, easing: "cubic-bezier(0.2,0.8,0.2,1)" };
    if ((from.size || fromBoxes) && !reducedNow()) {
      const targets = [...el.querySelectorAll<HTMLElement>(".card")].flatMap((node) => {
        const next = node.getBoundingClientRect();
        const old = from.get(node.dataset.id!) ?? derive(node.dataset.id!, next);
        return old ? [{ node, old, next }] : [];
      });
      for (const { node, old, next } of targets) {
        if (!next.width || !next.height || typeof node.animate !== "function") continue;
        // 没有移动、没有变大小的卡片不起动画（#109：读下一页时已有卡片的位置不变）。
        if (Math.abs(old.left - next.left) < 0.5 && Math.abs(old.top - next.top) < 0.5 && Math.abs(old.width - next.width) < 0.5 && Math.abs(old.height - next.height) < 0.5) continue;
        const motion = node.animate([
          { transform: `translate(${old.left - next.left}px, ${old.top - next.top}px) scale(${old.width / next.width}, ${old.height / next.height})` },
          { transform: "none" },
        ], timing);
        // 与面板的过渡对齐起点：两段同节奏的移动合起来才是一段直线。
        if (slide?.startTime != null) motion.startTime = slide.startTime;
        motions.current.set(node.dataset.id!, motion);
        motion.onfinish = () => motions.current.delete(node.dataset.id!);
        // 图库标记是卡片的兄弟、按新位置摆着：跟卡片右下角一起从旧位置滑过来，保留它自身的 translate(-100%, -100%)。
        const badge = node.nextElementSibling;
        if (badge instanceof HTMLElement && badge.classList.contains("card-sources")) {
          const badgeMotion = badge.animate([
            { transform: `translate(${old.right - next.right}px, ${old.bottom - next.bottom}px) translate(-100%, -100%)` },
            { transform: "translate(-100%, -100%)" },
          ], timing);
          if (slide?.startTime != null) badgeMotion.startTime = slide.startTime;
          const key = `${node.dataset.id!}
sources`;
          motions.current.set(key, badgeMotion);
          badgeMotion.onfinish = () => motions.current.delete(key);
        }
      }
    }
  }, [layout, ids, width, cards.length, cursor, syncMount]);
}

/**
 * 容器宽度变化时重排；拖动面板边缘时与单击后的双击间隔里先不重排（#157、#179）。
 * 面板开合（settle）时一开始就按终点宽度排，进行中不再跟着容器变（#162）。
 */
export function useWidthSync({ holdReflow, settle, slideMotion, scroller, layoutWidth, measureBeforeReflow, setWidth, syncMount }: {
  holdReflow: boolean;
  settle: PanelSlide | null;
  slideMotion: MutableRefObject<PanelSlide | null>;
  scroller: MutableRefObject<HTMLDivElement | null>;
  layoutWidth: MutableRefObject<number>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
  setWidth: (width: number) => void;
  syncMount: (el: HTMLElement) => void;
}) {
  const holding = useRef(holdReflow || !!settle);
  holding.current = holdReflow || !!settle;
  /** 单击卡片后到双击间隔结束的时刻（performance.now）：之前不重排（#179）。 */
  const clickHoldUntil = useRef(0);
  const clickHoldTimer = useRef(0);
  useEffect(() => () => clearTimeout(clickHoldTimer.current), []);
  const syncWidth = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const el = scroller.current!;
    const sync = () => {
      const held = holding.current || performance.now() < clickHoldUntil.current;
      // 还没排过（在过渡中途重建）时照常先排一次。
      if ((!held || !layoutWidth.current) && el.clientWidth !== layoutWidth.current) {
        measureBeforeReflow(true);
        layoutWidth.current = el.clientWidth;
        setWidth(el.clientWidth);
      }
      syncMount(el);
    };
    syncWidth.current = sync;
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => flushSync(sync));
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureBeforeReflow, syncMount]);
  // 面板开始滑：墙的终点宽度已知，现在就按它排，卡片随面板一起到位。
  useLayoutEffect(() => {
    const el = scroller.current;
    // 拖动中不排；松手时这段滑动的变化量已经过时，等它结束再按实际宽度排。
    if (!settle || holdReflow || !el || !layoutWidth.current) return;
    const target = Math.round(el.clientWidth + settle.by);
    if (target <= 0 || target === layoutWidth.current) return;
    measureBeforeReflow(true);
    slideMotion.current = settle;
    layoutWidth.current = target;
    setWidth(target);
  }, [settle]); // eslint-disable-line react-hooks/exhaustive-deps
  // 宽度稳定了：按最终宽度重排一次（双击间隔还没过时，由下面的计时到点后再排）。
  const still = !holdReflow && !settle;
  useLayoutEffect(() => { if (still) syncWidth.current(); }, [still]);
  /** 单击卡片：双击间隔结束前不重排，结束时若宽度也稳定了就重排一次。 */
  const holdForDoubleClick = () => {
    const wait = doubleClickSettings().intervalMs;
    clickHoldUntil.current = performance.now() + wait;
    clearTimeout(clickHoldTimer.current);
    clickHoldTimer.current = window.setTimeout(() => {
      clickHoldUntil.current = 0;
      if (!holding.current) syncWidth.current();
    }, wait);
  };
  return { holdForDoubleClick };
}
