// 查看器开合时缩略图与原图之间的共享元素过渡（#449）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { motion } from "motion/react";
import { arcSpring } from "../ui/Dock";
import { useReducedMotion } from "../ui/reducedMotion";
import type { BrowserCard } from "../wall/wallShared";

export type FlightRect = { x: number; y: number; width: number; height: number };
/** 查看器此刻把图放在哪（窗口坐标），以及位图读到了哪一步。 */
export type ViewerPlaced = { rect: FlightRect; src: string | null; settled: boolean };
/** 查看器的过渡阶段，写在 `.viewer[data-flight]` 上，顶栏、Dock 与底色的进退由样式接管。 */
export type ViewerFlightAttr = "fly-in" | "land" | "fade-in" | "fade-out";

type Fly = {
  kind: "fly"; direction: "open" | "close"; card: BrowserCard; cardEl: HTMLElement;
  /** 飞行元素按卡片的矩形排版，靠变换到达查看区：放大只会加重遮蔽的模糊，从大尺寸缩小才会减轻它。 */
  box: FlightRect; host: { x: number; y: number }; radius: string; src: string; veiled: boolean;
  from: FlightRect; to: FlightRect | null;
  /** 看上去到位了（弹簧的 visualDuration）：顶栏与 Dock 此时进入，不等弹簧的尾巴。 */
  inPlace: boolean;
  /** 真正落定（差不到 1 px）：此时才能换上原图。 */
  arrived: boolean; settled: boolean;
};
type Stage =
  | { kind: "measure"; direction: "open" | "close"; card: BrowserCard; resume: Fly | null }
  | Fly
  | { kind: "fade-in"; card: BrowserCard }
  | { kind: "fade-out"; card: BrowserCard }
  | null;

/** 读动效令牌的毫秒数；减弱动效时令牌为 0。 */
export const tokenMs = (name: string) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) ? (raw.endsWith("ms") ? value : value * 1000) : 0;
};

/**
 * 能作为飞行起点或落点的卡片：挂载着、有大小、至少一部分在图片墙的视口里，且没有交给封印或释放的影子。
 * 找不到时（墙外的图、被移走的图）退回淡入淡出。
 */
export function flightCard(id: string, host: HTMLElement | null): { el: HTMLElement; rect: FlightRect } | null {
  const el = host?.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
  const wall = el?.closest<HTMLElement>(".wall");
  if (!el || !wall || el.dataset.leaving === "true" || el.classList.contains("is-arriving")) return null;
  const rect = el.getBoundingClientRect();
  const view = wall.getBoundingClientRect();
  const inView = rect.right > view.left && rect.left < view.right && rect.bottom > view.top && rect.top < view.bottom;
  return rect.width > 0 && rect.height > 0 && inView ? { el, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } } : null;
}

const transformTo = (box: FlightRect, rect: FlightRect) => ({
  x: rect.x - box.x, y: rect.y - box.y, scaleX: rect.width / box.width, scaleY: rect.height / box.height,
});

const cardImage = (el: HTMLElement) => {
  // 一摞（#418）取封面那张图，不取下面的纸：纸上的页可能是遮着的成人内容。
  const img = el.querySelector<HTMLImageElement>(":scope > img, :scope > .stack-cover > img");
  return img?.currentSrc || img?.getAttribute("src") || "";
};

/**
 * 查看器开合的状态机。查看器保持挂载到飞行结束；`viewing` 变空时图片墙立刻接回焦点与滚动，不等动画。
 *
 * 用 motion 而不用 `startViewTransition`：后者要给新旧画面拍快照，查看器里的原图可能进入快照，安全模式下不能接受；
 * 过渡期间整页还会被冻结、不能交互，中途按返回也接不上。这里飞的是一个独立元素，遮蔽时它只拿卡片上的缩略图，原图全程隐藏。
 */
export function useViewerFlight({ viewing, safe, host, instant }: {
  viewing: BrowserCard | null; safe: boolean; host: RefObject<HTMLElement | null>; instant: boolean;
}) {
  const reduced = useReducedMotion();
  const animated = !reduced && !instant;
  const lastCard = useRef(viewing);
  if (viewing) lastCard.current = viewing;
  const placed = useRef<ViewerPlaced | null>(null);
  const [session, setSession] = useState(0);
  const [prevId, setPrevId] = useState<string | null>(viewing?.id ?? null);
  const [stage, setStage] = useState<Stage>(null);
  /** 这次关闭是画师按的返回。别的关闭（修订前进、安全模式、图已不在）是撤销这张图，不能再把它留在屏幕上。 */
  const [backing, setBacking] = useState(false);
  const id = viewing?.id ?? null;
  const sealed = (card: BrowserCard | null) => !!card?.adult && safe;
  if (id !== prevId) {
    setPrevId(id);
    if (id === null) {
      setBacking(false);
      const card = lastCard.current!;
      const resume = stage?.kind === "fly" && stage.direction === "open" ? stage : null;
      setStage(animated && backing && !sealed(card) ? { kind: "measure", direction: "close", card, resume } : null);
    } else if (prevId === null) {
      placed.current = null;
      setSession((value) => value + 1);
      setStage(animated ? { kind: "measure", direction: "open", card: viewing!, resume: null } : null);
    } else {
      // 飞行中换了图：直接到位。
      setStage(null);
    }
  }
  // 过渡中途要求不再有动画（打开减弱动效、捕获请求）：直接到终态。
  if (stage && !animated) setStage(null);
  const closing = stage && (stage.kind === "fade-out" || ((stage.kind === "fly" || stage.kind === "measure") && stage.direction === "close"));
  // 飞回途中开启安全模式：立刻收掉。
  if (closing && sealed(stage.card)) setStage(null);

  useLayoutEffect(() => {
    if (stage?.kind !== "measure") return;
    const target = flightCard(stage.card.id, host.current);
    const hostRect = host.current?.getBoundingClientRect();
    if (stage.direction === "open") {
      if (!target || !hostRect) { setStage({ kind: "fade-in", card: stage.card }); return; }
      setStage({
        kind: "fly", direction: "open", card: stage.card, cardEl: target.el, box: target.rect, host: { x: hostRect.left, y: hostRect.top },
        radius: getComputedStyle(target.el).borderRadius || "0px", src: cardImage(target.el), veiled: target.el.dataset.veiled === "true",
        from: target.rect, to: placed.current?.rect ?? null, inPlace: false, arrived: false, settled: placed.current?.settled ?? false,
      });
      return;
    }
    if (!target || !hostRect) {
      setStage(tokenMs("--t") > 0 ? { kind: "fade-out", card: stage.card } : null);
      return;
    }
    if (stage.resume) {
      setStage({ ...stage.resume, direction: "close", to: target.rect, inPlace: false, arrived: false });
      return;
    }
    const veiled = target.el.dataset.veiled === "true";
    setStage({
      kind: "fly", direction: "close", card: stage.card, cardEl: target.el, box: target.rect, host: { x: hostRect.left, y: hostRect.top },
      radius: getComputedStyle(target.el).borderRadius || "0px", src: (!veiled && placed.current?.src) || cardImage(target.el), veiled,
      from: placed.current?.rect ?? target.rect, to: target.rect, inPlace: false, arrived: false, settled: true,
    });
  }, [stage, host]);

  // 中途掉头时量落点这一步也留着飞行元素，它接着当前的位置与速度飞回去。
  const flying = stage?.kind === "fly" ? stage : stage?.kind === "measure" ? stage.resume : null;
  // 卡片用透明度藏起来而不是 visibility：图片墙刚把焦点接回它，不能丢。
  // 和飞行元素的增删在同一次提交里生效，否则落地时卡片会空一帧。
  const cardEl = flying?.cardEl;
  useLayoutEffect(() => {
    if (!cardEl) return;
    cardEl.dataset.flying = "";
    return () => { delete cardEl.dataset.flying; };
  }, [cardEl]);

  const flyingIn = !!flying && flying.direction === "open" && !flying.inPlace;
  useEffect(() => {
    if (!flyingIn) return;
    const timer = window.setTimeout(() => setStage((current) => current?.kind === "fly" && current.direction === "open" ? { ...current, inPlace: true } : current), arcSpring.smooth.visualDuration * 1000);
    return () => window.clearTimeout(timer);
  }, [flyingIn]);
  const fading = !!flying && flying.direction === "open" && flying.arrived && flying.settled && !sealed(flying.card);
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => setStage(null), tokenMs("--t-fast"));
    return () => window.clearTimeout(timer);
  }, [fading]);
  const fadeOut = stage?.kind === "fade-out";
  useEffect(() => {
    if (!fadeOut) return;
    const timer = window.setTimeout(() => setStage(null), tokenMs("--t"));
    return () => window.clearTimeout(timer);
  }, [fadeOut]);

  const onPlaced = useCallback((next: ViewerPlaced) => {
    placed.current = next;
    setStage((current) => {
      if (current?.kind !== "fly" || current.direction !== "open") return current;
      const { to, settled } = current;
      const same = to && to.x === next.rect.x && to.y === next.rect.y && to.width === next.rect.width && to.height === next.rect.height;
      return same && settled === next.settled ? current : { ...current, to: next.rect, settled: next.settled };
    });
  }, []);
  /** 画师按返回：和 `setViewing(null)` 一起调用，查看器才飞回卡片。 */
  const back = useCallback(() => setBacking(true), []);
  /** 飞回途中图片被撤销：当场收掉。 */
  const cut = useCallback(() => setStage(null), []);
  const landed = useCallback(() => {
    setStage((current) => current?.kind !== "fly" ? current : current.direction === "close" ? null : current.arrived ? current : { ...current, arrived: true });
  }, []);

  const card = viewing ?? (closing && !sealed(stage.card) ? stage.card : null);
  const attr: ViewerFlightAttr | undefined = !stage ? undefined
    : stage.kind === "fade-in" ? "fade-in"
    : stage.kind === "fade-out" ? "fade-out"
    : stage.direction === "close" ? "land"
    : stage.kind === "fly" && stage.inPlace ? undefined : "fly-in";
  return {
    card, session, attr, onPlaced, back, cut,
    /** 飞行期间与安全模式下，查看区不显示原图。 */
    hideImage: sealed(card) || (!!stage && (stage.kind === "measure" || (stage.kind === "fly" && !fading))),
    /** 墙、侧栏与详情面板退到背景，只在图片飞行时。 */
    dim: !!flying && !flying.inPlace,
    flier: flying?.to ? <ViewerFlier key={`flier:${session}`} flight={flying} to={flying.to} veiled={flying.veiled || sealed(flying.card)} fading={fading} onLanded={landed} /> : null,
  };
}

function ViewerFlier({ flight, to, veiled, fading, onLanded }: {
  flight: Fly; to: FlightRect; veiled: boolean; fading: boolean; onLanded: () => void;
}) {
  const { box, host, direction, radius, src, from } = flight;
  const opening = direction === "open";
  const spring = opening ? arcSpring.smooth : { ...arcSpring.snappy, delay: tokenMs("--t-fast") / 1000 };
  return (
    <div className="viewer-flight" aria-hidden="true">
      <motion.div className="viewer-flier" data-veiled={veiled} data-fading={fading || undefined}
        style={{ left: box.x - host.x, top: box.y - host.y, width: box.width, height: box.height, originX: 0, originY: 0 }}
        initial={{ ...transformTo(box, from), borderRadius: opening ? radius : "0px" }}
        animate={{ ...transformTo(box, to), borderRadius: opening ? "0px" : radius }}
        // 缩放差到相当于 1 px 就算落定；默认精度下弹簧的尾巴要多拖几百毫秒。
        transition={{ ...spring, scaleX: { ...spring, restDelta: 1 / box.width }, scaleY: { ...spring, restDelta: 1 / box.height } }}
        onAnimationComplete={onLanded}>
        {/* 遮蔽中的飞行元素只拿卡片上的缩略图；模糊与遮罩的样式与卡片同一条规则。 */}
        {src && <img src={src} alt="" draggable={false} />}
      </motion.div>
    </div>
  );
}
