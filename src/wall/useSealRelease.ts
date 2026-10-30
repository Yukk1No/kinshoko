// 安全模式的封印与释放（#27，原型 sealfx）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { MAX_GHOSTS, SEAL, SealFx, type FxArrival, type FxSource } from "../shell/sealfx";
import { safeTiming } from "../shell/safeTiming";
import { reducedNow, useReducedMotion } from "../ui/reducedMotion";
import type { masonry } from "./layout";
import { RELEASE_WAIT, type BrowserCard, type LayoutSnapshot } from "./wallShared";

type SafeReflow = {
  rects: Map<string, DOMRect>; boxes: LayoutSnapshot; at: number; delay: number; duration: number;
  /** 存下之后卡片又被别的重排挪过（例如墙变宽）：起点按用时量到的位置，不用存下的。 */
  moved?: boolean;
};

export function useSealRelease({
  safeMode, cards, setCards, scroller, shownCards, live, safeReflow, sealDrop, measureBeforeReflow, viewerOpen, releasePage,
}: {
  safeMode: boolean;
  cards: BrowserCard[];
  setCards: Dispatch<SetStateAction<BrowserCard[]>>;
  scroller: MutableRefObject<HTMLDivElement | null>;
  shownCards: MutableRefObject<BrowserCard[]>;
  live: MutableRefObject<{ layout: ReturnType<typeof masonry> | null; ids: string[] }>;
  safeReflow: MutableRefObject<SafeReflow | null>;
  sealDrop: MutableRefObject<number>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
  viewerOpen: boolean;
  releasePage: MutableRefObject<boolean>;
}) {
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
  const landed = useCallback((id: string) => {
    // 影子在这一帧移走：卡片同一帧就得显示，不能等 React 下一次提交，否则中间空出一帧，落地时闪一下。
    // React 随后按 arriving 把类名设成同样的值。
    scroller.current?.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.classList.remove("is-arriving");
    setArriving((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s); n.delete(id); return n;
    });
  }, []);
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
  /** 现在的布局快照（还没按新的卡片重排）。 */
  const snapshotLayout = (): LayoutSnapshot => {
    const { layout: now, ids: shown } = live.current;
    return { boxes: new Map(now ? shown.map((id, i) => [id, now.boxes[i]]) : []), scrollTop: scroller.current?.scrollTop ?? 0 };
  };
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
  /** 视口里的成人卡片从书里飞回自己的位置（还在往书里飞的影子就地掉头），落地前卡片先藏着。 */
  const releaseOnScreen = (f: SealFx, b: DOMRect) => {
    const arrivals: FxArrival[] = onScreenAdult().slice(0, MAX_GHOSTS).map(({ id, src, rect }) => ({
      id, src, w: rect.width, h: rect.height,
      target: () => {
        const r = scroller.current?.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.getBoundingClientRect();
        return r && r.width > 0 ? r : null;
      },
    }));
    if (!arrivals.length) return;
    safeTiming.mark("释放动画开始");
    setArriving(new Set(arrivals.map((a) => a.id)));
    f.release(arrivals, b, landed);
  };
  useLayoutEffect(() => {
    if (lastSafe.current === safeMode) return;
    lastSafe.current = safeMode;
    releaseDue.current = 0;
    const sealing = sealDrop.current !== 0;
    cancelAnimationFrame(sealDrop.current);
    sealDrop.current = 0;
    safeReflow.current = null;
    const f = fx.current, b = book();
    if (!f || !b || viewerOpen || reducedNow()) {
      // 查看器盖着墙或减少动态效果：封印的图直接不见，放出的图直接在。
      f?.clear(); setArriving(new Set());
      if (safeMode && shownCards.current.some((c) => c.adult)) setCards((current) => current.filter((c) => !c.adult));
      return;
    }
    if (!safeMode && sealing) {
      // 影子还没起飞让位就关闭：成人图仍在原位，影子立刻掉头飞回，不等资料库；墙上没有卡片要挪。
      releaseOnScreen(f, b);
      return;
    }
    // 原型：封印时留下的卡片等影子起飞后（flyAt + 20）用 620 ms 补位；释放时 40 ms 后用 680 ms 让位。
    safeReflow.current = {
      rects: new Map(onScreen().map((c) => [c.id, c.rect])), boxes: snapshotLayout(), at: performance.now(),
      delay: safeMode ? SEAL.flyAt + 20 : 40, duration: safeMode ? 620 : 680,
    };
    if (safeMode) {
      // 还在往外飞的影子先掉头（原型 Q111），再让墙上的成人图飞进书里。
      f.seal(onScreenAdult() satisfies FxSource[], b);
      setArriving(new Set());
      // 影子起飞后（flyAt + 20）就让出位置，不等资料库确认：资料库慢时补位不会停顿，回来的同一批卡片也不再重排。
      const dropAt = performance.now() + SEAL.flyAt + 20;
      const drop = () => {
        if (performance.now() < dropAt) { sealDrop.current = requestAnimationFrame(drop); return; }
        sealDrop.current = 0;
        // 没有图要让位：撤掉切换时量下的位置，免得之后无关的重排沿用它和封印的节奏。
        if (!shownCards.current.some((c) => c.adult)) { safeReflow.current = null; return; }
        measureBeforeReflow();
        setCards((current) => current.filter((c) => !c.adult));
      };
      sealDrop.current = requestAnimationFrame(drop);
    } else {
      releaseDue.current = performance.now() + RELEASE_WAIT;
      releasePage.current = false;
    }
  }, [safeMode]); // eslint-disable-line react-hooks/exhaustive-deps
  return { revealed, arriving, fxHost, fx, releaseDue, book, releaseOnScreen };
}

export function useReleaseLanding({ releaseDue, safeMode, cards, layout, width, releasePage, fx, book, viewerOpen, releaseOnScreen }: {
  releaseDue: MutableRefObject<number>;
  safeMode: boolean;
  cards: BrowserCard[];
  layout: ReturnType<typeof masonry>;
  width: number;
  releasePage: MutableRefObject<boolean>;
  fx: MutableRefObject<SealFx | null>;
  book: () => DOMRect | undefined;
  viewerOpen: boolean;
  releaseOnScreen: (f: SealFx, b: DOMRect) => void;
}) {
  // 关闭安全模式后，资料库送回的成人图排好了位置：它们就是从书里飞出的落点。
  useLayoutEffect(() => {
    const due = releaseDue.current;
    if (!due || safeMode || !cards.length || !width) return;
    // 资料库还没按新视角送回（例如详情面板收起只改了宽度）：接着等，不作废这次释放。
    // 送回的那一页没有成人图时这次释放就此结束，之后别的浏览带来的成人图不从书里飞出。
    if (performance.now() <= due && !releasePage.current) return;
    releaseDue.current = 0;
    if (!cards.some((c) => c.adult)) return;
    // 只在真有图要飞回时才量封印书：这个效果每次墙上的卡片变化都会跑，量它会多强制排一次版（#176）。
    const f = fx.current, b = book();
    if (!f || !b || performance.now() > due || viewerOpen || reducedNow()) return;
    releaseOnScreen(f, b);
  }, [cards, layout, width]); // eslint-disable-line react-hooks/exhaustive-deps
}
