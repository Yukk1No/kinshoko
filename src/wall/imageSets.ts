// 图片墙上的图集（#418）：叠成一摞的格子，与打开时让出的原位托盘。
import { useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { Anchor, LayoutInput, TrayInput } from "./layout";
import { stackInset } from "./stackPaper";
import { CAP_RATIO, STACK_SETS_READY, type BrowserCard } from "./wallShared";

/** 托盘的内边距（CSS 像素，界面缩放 100% 时；第 5 版原型）。 */
export const TRAY_PAD = 14;

/**
 * 墙上实际排的格子：`key` 指向的那一摞换成它的各页（按页序，排进托盘），其余照旧。
 * 找不到这一摞时（已离开结果）没有托盘。
 */
export function expandTray(cards: BrowserCard[], key: string | null): { shown: BrowserCard[]; tray: Omit<TrayInput, "pad"> | null } {
  const at = key === null ? -1 : cards.findIndex((card) => card.set?.key === key);
  if (at < 0) return { shown: cards, tray: null };
  const pages = cards[at].set!.pages;
  return { shown: [...cards.slice(0, at), ...pages, ...cards.slice(at + 1)], tray: { at, count: pages.length } };
}

/** 一摞的格子四周的内缩（布局单位）：按最外扩的纸角算，见 stackInset。 */
export function cardInset(card: BrowserCard, columnWidth: number, uiScale: number) {
  const set = card.set!;
  return stackInset(set.key, set.pages.map((page) => ({ w: page.width, h: page.height })), columnWidth, CAP_RATIO, 1 / uiScale);
}

/** 收着 `id` 这一页的那一摞（封面 id）；`id` 本身就在墙上或不在这些格子里时为 null。 */
export function stackHolding(cards: readonly BrowserCard[], id: string) {
  if (cards.some((card) => card.id === id)) return null;
  return cards.find((card) => card.set?.pages.some((page) => page.id === id))?.id ?? null;
}

/** 要记下的滚动位置：落在托盘里的页上时记成这一摞，下次进来托盘是关着的，页不在墙上。 */
export function storableAnchor(anchor: Anchor | null, shown: BrowserCard[], tray: Omit<TrayInput, "pad"> | null, trayIds: ReadonlySet<string>) {
  return anchor && tray && trayIds.has(anchor.id) ? { id: shown[tray.at].id, delta: 0 } : anchor;
}

/** 一摞下面要遮住的纸（以空格分隔的页 id）：按各页自己的 adult，封面不是成人内容时纸上的页也可能是。 */
export function veiledSheets(card: BrowserCard, safeMode: boolean, revealed: ReadonlySet<string>) {
  return card.set ? card.set.pages.filter((p) => p.adult && (safeMode || !revealed.has(p.id))).map((p) => p.id).join(" ") : "";
}

/** 排瀑布流用的尺寸：一摞四周留出纸边的内缩。 */
export function layoutItems(shown: BrowserCard[], uiScale: number): LayoutInput {
  return shown.map((card) => card.set
    ? { w: card.width, h: card.height, inset: (columnWidth: number) => cardInset(card, columnWidth, uiScale) }
    : { w: card.width, h: card.height });
}

/**
 * 打开着托盘的那一摞（同一时刻只开一个），与墙上实际排的格子：那一摞换成它的各页，排进托盘。
 * 那一摞离开结果时（删除、换了查找）托盘随之关上。
 */
export function useOpenTray(cards: BrowserCard[], stackSets: boolean) {
  const [openSet, setOpenSet] = useState<string | null>(null);
  const { shown, tray } = useMemo(() => expandTray(cards, stackSets ? openSet : null), [cards, openSet, stackSets]);
  const trayIds = useMemo(() => new Set(tray ? shown.slice(tray.at, tray.at + tray.count).map((c) => c.id) : []), [shown, tray]);
  useEffect(() => { if (openSet !== null && !tray) setOpenSet(null); }, [openSet, tray]);
  return { openSet, setOpenSet, shown, tray, trayIds };
}

/**
 * 「叠放图集」开关（#418），默认开；还没露出时（见 STACK_SETS_READY）关着，菜单里也没有这一项。
 * 切换后墙重新挂载、页的格子变了：`onToggle` 让调用方清掉选择，免得详情面板还在编辑看不见的页。
 */
export function useStackSetsSetting(onToggle: () => void) {
  const [on, setOn] = useState(STACK_SETS_READY);
  return { on, menu: STACK_SETS_READY ? { on, toggle: () => { setOn((value) => !value); onToggle(); } } : undefined };
}

/** 托盘开着时点顶栏也关托盘；点详情面板不关，面板显示的正是托盘里的选择。 */
export function useCloseTrayOnTopbar(openSet: string | null, leaveTray: MutableRefObject<() => void>) {
  useEffect(() => {
    if (openSet === null) return;
    const onDown = (e: PointerEvent) => { if ((e.target as Element | null)?.closest?.(".topbar")) leaveTray.current(); };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [openSet, leaveTray]);
}
