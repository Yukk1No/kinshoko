// 托盘的开合（#418 第 5 版原型）：打开时各页从封面的位置飞到托盘里，关上时飞回落下的那一摞。
// 其他格子由重排的滑动动画（useReflow）从旧位置滑到新位置；这里只补上各页的起点与关上时的影子。
import { useCallback, useLayoutEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { thumbnailUrl } from "../ipc";
import { reducedNow } from "../ui/reducedMotion";
import { tokenMs } from "../viewer/ViewerFlight";
import type { Anchor, Layout } from "./layout";
import { cardThumbnail } from "./thumbnailTier";
import type { BrowserCard } from "./wallShared";

/** 托盘开合这一次重排的节奏：飞的那几页用弹簧，其余格子用缓动，时长都是 `--t-slow`。 */
export type TrayMotion = { flights: ReadonlySet<string> };

/** 读动效令牌的曲线；读不到时（测试环境）为线性。 */
export const tokenEasing = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "linear";

/** 墙上这一格的节点（id 不经转义，逐个比对）。 */
const cardNode = (el: HTMLElement | null, id: string) =>
  [...(el?.querySelectorAll<HTMLElement>(".card") ?? [])].find((node) => node.dataset.id === id) ?? null;

type Ghost = { card: BrowserCard; from: { x: number; y: number; w: number; h: number } };

export function useTrayMotion({
  scroller, layout, ids, shown, tray, openSet, setOpenSet, anchor, settledTop, beforeReflow, measureBeforeReflow, trayMotion, thumbnailPx, veiled, safeMode,
}: {
  scroller: MutableRefObject<HTMLDivElement | null>;
  layout: Layout;
  ids: string[];
  shown: BrowserCard[];
  tray: { at: number; count: number } | null;
  openSet: string | null;
  setOpenSet: Dispatch<SetStateAction<string | null>>;
  anchor: MutableRefObject<Anchor | null>;
  settledTop: MutableRefObject<number | null>;
  beforeReflow: MutableRefObject<Map<string, DOMRect>>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
  trayMotion: MutableRefObject<TrayMotion | null>;
  thumbnailPx: number;
  /** 这一页现在要不要遮（成人内容、安全模式或还没放出）：影子照着遮。 */
  veiled: (card: BrowserCard) => boolean;
  safeMode: boolean;
}) {
  const live = useRef({ layout, ids, shown, tray, openSet, veiled });
  live.current = { layout, ids, shown, tray, openSet, veiled };
  /** 关托盘时焦点在托盘里：渲染后交给这一摞，回车、Ctrl+A 照常可用。 */
  const focusStack = useRef<string | null>(null);
  /** 刚打开的托盘：渲染后把焦点交给第一页。 */
  const focusFirst = useRef<string | null>(null);
  /** 刚关上的托盘：渲染后各页的影子从托盘里的位置飞回这一摞。 */
  const gather = useRef<{ stack: string; ghosts: Ghost[] } | null>(null);

  const openTray = useCallback((card: BrowserCard) => {
    const set = card.set;
    if (!set) return;
    measureBeforeReflow();
    // 锚点改到被点的这一摞，它留在屏幕原处、托盘从这里长出来：托盘从最长的一列底下开始，
    // 不锚定时会把它挪出视口；从一个托盘直接换过来时，旧托盘里的页也要离开墙。
    const { layout, ids } = live.current;
    const el = scroller.current;
    const index = ids.indexOf(card.id);
    if (el && index >= 0) {
      anchor.current = { id: card.id, delta: el.scrollTop - layout.boxes[index].y };
      settledTop.current = null;
    }
    // 各页从封面的位置飞出：封面就是第一页，其余各页的起点也设在封面上。
    const cover = cardNode(scroller.current, card.id)?.querySelector<HTMLElement>(".stack-cover");
    const from = cover?.getBoundingClientRect();
    if (from && from.width > 0) for (const page of set.pages) beforeReflow.current.set(page.id, from);
    trayMotion.current = { flights: new Set(set.pages.map((page) => page.id)) };
    focusFirst.current = set.pages[0]?.id ?? null;
    setOpenSet(set.key);
  }, [measureBeforeReflow, setOpenSet, scroller, anchor, settledTop, beforeReflow, trayMotion]);

  const closeTray = useCallback((keep?: string) => {
    const { layout, ids, shown, tray, openSet } = live.current;
    const el = scroller.current;
    if (openSet === null || !tray || !el) { setOpenSet(null); return; }
    const pages = shown.slice(tray.at, tray.at + tray.count);
    const stack = pages[0].id;
    const focused = document.activeElement;
    focusStack.current = focused instanceof HTMLElement && pages.some((page) => page.id === focused.dataset.id || page.id === focused.dataset.card) ? stack : null;
    measureBeforeReflow();
    trayMotion.current = { flights: new Set([stack]) };
    // 被点的那一格留在屏幕原处；否则正在看的若是托盘里的页，这一摞落在托盘原来的位置。
    const index = keep === undefined ? -1 : ids.indexOf(keep);
    const inTray = (id: string | undefined) => pages.some((page) => page.id === id);
    if (index >= 0) anchor.current = { id: keep!, delta: el.scrollTop - layout.boxes[index].y };
    // 托盘顶已滚出视口时（看到托盘深处），这一摞贴着视口顶落下，不按到托盘顶的距离落到后面的格子里。
    else if (!anchor.current || inTray(anchor.current.id)) anchor.current = { id: stack, delta: Math.min(0, el.scrollTop - layout.tray!.y) };
    settledTop.current = null;
    gather.current = reducedNow() ? null : {
      stack,
      ghosts: pages.slice(1).flatMap((card, i) => {
        const box = layout.boxes[tray.at + 1 + i];
        // 只为看得见的页做影子：屏幕外的页直接回到摞里。
        const visible = box.y + box.h >= el.scrollTop && box.y <= el.scrollTop + el.clientHeight;
        return visible ? [{ card, from: box }] : [];
      }),
    };
    setOpenSet(null);
  }, [measureBeforeReflow, setOpenSet, scroller, anchor, settledTop, trayMotion]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在托盘开合后的那次提交里交焦点、放影子；ids、layout、thumbnailPx 只在那一刻读
  useLayoutEffect(() => {
    const el = scroller.current;
    const first = openSet !== null ? focusFirst.current : focusStack.current;
    focusFirst.current = null;
    focusStack.current = null;
    if (first && el) cardNode(el, first)?.focus({ preventScroll: true });
    const pending = gather.current;
    gather.current = null;
    if (!pending || openSet !== null || !el) return;
    const node = cardNode(el, pending.stack);
    const host = el.querySelector<HTMLElement>(".wall-ghosts");
    const index = ids.indexOf(pending.stack);
    if (!node || !host || index < 0) return;
    const box = layout.boxes[index];
    const inset = node.querySelector<HTMLElement>(".stack-cover")?.offsetLeft ?? 0;
    const to = { x: box.x + inset, y: box.y + inset, w: box.w - inset * 2, h: box.h - inset * 2 };
    const duration = tokenMs("--t-slow");
    const easing = tokenEasing("--spring");
    // 第 1 页（就是这一摞本身）最后落下、压在最上面；落下之前这一摞的纸边先不显现。
    node.dataset.gathering = "";
    const flights: Animation[] = [];
    for (const { card, from } of [...pending.ghosts].reverse()) {
      const ghost = document.createElement("div");
      ghost.className = "tray-ghost";
      Object.assign(ghost.style, { left: `${to.x}px`, top: `${to.y}px`, width: `${to.w}px`, height: `${to.h}px` });
      // 成人内容的页：影子也遮着（CSS 只留纸底），飞到一半开了安全模式时再补上（见下方）。
      const hidden = live.current.veiled(card);
      ghost.dataset.veiled = String(hidden);
      if (card.adult) ghost.dataset.adult = "";
      if (card.placeholder && !hidden) ghost.style.backgroundImage = `url("${card.placeholder}")`;
      const img = document.createElement("img");
      img.src = thumbnailUrl(cardThumbnail(card, thumbnailPx));
      img.alt = "";
      ghost.appendChild(img);
      host.appendChild(ghost);
      const flight = ghost.animate([
        { transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})` },
        { transform: "none" },
      ], { duration, easing });
      flight.onfinish = flight.oncancel = () => ghost.remove();
      flights.push(flight);
    }
    const landed = () => { delete node.dataset.gathering; };
    if (!flights.length) { landed(); return; }
    const timer = window.setTimeout(landed, duration);
    return () => { clearTimeout(timer); landed(); flights.forEach((flight) => flight.cancel()); };
  }, [openSet]);

  // 影子飞到一半时开了安全模式：成人内容的页的影子立即遮住。
  useLayoutEffect(() => {
    if (!safeMode) return;
    scroller.current?.querySelectorAll<HTMLElement>(".tray-ghost[data-adult]").forEach((ghost) => {
      ghost.dataset.veiled = "true";
      ghost.style.backgroundImage = "";
    });
  }, [safeMode, scroller]);

  return { openTray, closeTray };
}
