// 图片墙上的图集（#418）：叠成一摞的格子，与打开时让出的原位托盘。
import { useEffect, useMemo, useState } from "react";
import type { LayoutInput, TrayInput } from "./layout";
import { STACK_INSET } from "./stackPaper";
import { STACK_SETS_READY, type BrowserCard } from "./wallShared";

/** 托盘的上下内边距（CSS 像素，界面缩放 100% 时）。 */
export const TRAY_PAD = 12;

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

/** 排瀑布流用的尺寸：一摞四周留出纸边的内缩。 */
export function layoutItems(shown: BrowserCard[], uiScale: number): LayoutInput {
  return shown.map((card) => card.set ? { w: card.width, h: card.height, inset: STACK_INSET / uiScale } : { w: card.width, h: card.height });
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

/** 「叠放图集」开关（#418），默认开；还没露出时（见 STACK_SETS_READY）关着，菜单里也没有这一项。 */
export function useStackSetsSetting() {
  const [on, setOn] = useState(STACK_SETS_READY);
  return { on, menu: STACK_SETS_READY ? { on, toggle: () => setOn((value) => !value) } : undefined };
}
