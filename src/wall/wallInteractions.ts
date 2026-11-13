// 图片墙上的选择、键盘、右键与拖出，以及 Ctrl+V 导入（#105）。
import { useEffect, useEffectEvent } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { modalOpen } from "../ui/modal";
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import type { Press } from "./doubleClick";
import type { WallMenuTarget } from "./WallMenu";
import { pagesOf } from "./imageSets";
import { CARD_BUTTONS, DRAG_IMAGE_SOURCES, DRAG_IMAGES, editable, type BrowserCard, type CardCommand } from "./wallShared";

export function wallInteractions({
  ids, cards, selected, onSelectionChange, pivot, lastPress, pendingClick, holdForDoubleClick, open, selectAllRef,
  setMenuTarget, menu, onCardCommand, scope, workspaceScope, trayIds, closeTray,
}: {
  ids: string[];
  cards: BrowserCard[];
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
  pivot: MutableRefObject<string | null>;
  lastPress: MutableRefObject<Press | null>;
  pendingClick: MutableRefObject<(Press & { id: string; opened: boolean }) | null>;
  holdForDoubleClick: () => void;
  open: (card: BrowserCard) => void;
  selectAllRef: MutableRefObject<() => void>;
  setMenuTarget: (target: WallMenuTarget | null) => void;
  menu: ((target: WallMenuTarget) => ReactNode) | undefined;
  onCardCommand: ((command: CardCommand, cards: BrowserCard[], point: { x: number; y: number }) => void) | undefined;
  scope: BrowseScope;
  workspaceScope: WorkspaceScope | undefined;
  /** 打开着的托盘里的各页（#418）；没有打开的托盘时为空。 */
  trayIds: ReadonlySet<string>;
  /** 关上托盘；`keep` 是关上后留在屏幕原处的那一格。 */
  closeTray: (keep?: string) => void;
}) {
  /** 托盘的第 1 页：关上后它就是这一摞，仍在墙上。 */
  const trayCover = trayIds.values().next().value;
  /** 去掉托盘里的页的选择；`keepCover` 时留下第 1 页（关托盘后它是这一摞）。 */
  const withoutTray = (from: ReadonlySet<string>, keepCover: boolean) =>
    new Set([...from].filter((id) => !trayIds.has(id) || (keepCover && id === trayCover)));
  const select = (id: string, e: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "metaKey">, change = onSelectionChange) => {
    if (e.shiftKey && pivot.current && ids.includes(pivot.current)) {
      const [a, b] = [ids.indexOf(pivot.current), ids.indexOf(id)].sort((x, y) => x - y);
      const next = e.ctrlKey || e.metaKey ? new Set(selected) : new Set<string>();
      ids.slice(a, b + 1).forEach((x) => next.add(x));
      change(next);
      return;
    }
    pivot.current = id;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (!next.delete(id)) next.add(id);
      change(next);
    } else {
      change(new Set([id]));
    }
  };
  /** 托盘里第 2 页往后的页离开选择（关托盘、换到别的托盘时）：免得操作落在看不见的图上。 */
  const pruneTray = () => {
    const next = withoutTray(selected, true);
    if (next.size !== selected.size) onSelectionChange(next);
  };
  /** 关上托盘（#418）：托盘里第 2 页往后的页随之离开墙，也离开选择。 */
  const leaveTray = (keep?: string) => {
    pruneTray();
    closeTray(keep);
  };
  /** 只取消托盘里的页的选择（Esc、点托盘背景）。 */
  const dropTraySelection = () => {
    if (![...selected].some((id) => trayIds.has(id))) return false;
    onSelectionChange(withoutTray(selected, false));
    return true;
  };


  /**
   * 单击卡片（#179）：未选中的只选中它；当前唯一选中的那张打开查看器；多选中不按修饰键单击其中一张，
   * 选择收缩为这一张（资源管理器的习惯）。这一下记作双击的第一下。
   */
  const click = (card: BrowserCard, e: MouseEvent) => {
    // 托盘开着时点到托盘以外的格子：关上托盘，同时选中那一格（#418），这一格留在屏幕原处。
    if (trayIds.size && !trayIds.has(card.id)) {
      closeTray(card.id);
      lastPress.current = null;
      select(card.id, e, (next) => onSelectionChange(withoutTray(next, true)));
      return;
    }
    const opens = !(e.ctrlKey || e.metaKey || e.shiftKey) && selected.size === 1 && selected.has(card.id);
    const at = lastPress.current ?? { at: performance.now(), x: e.clientX, y: e.clientY };
    lastPress.current = null;
    pendingClick.current = { ...at, id: card.id, opened: opens };
    holdForDoubleClick();
    if (opens) open(card); else select(card.id, e);
  };

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
    if (trayIds.size && !(e.target instanceof Element && e.target.closest(`.card, ${CARD_BUTTONS}, .wall-tray`))) leaveTray();
    if (e.ctrlKey || e.metaKey || e.shiftKey || !selected.size) return;
    if (e.target instanceof Element && e.target.closest(`.card, ${CARD_BUTTONS}`)) return;
    const el = e.currentTarget;
    if (e.clientX - el.getBoundingClientRect().left >= el.clientWidth) return;
    onSelectionChange(new Set());
  };
  const targetMenu = (e: MouseEvent) => {
    const point = { x: e.clientX, y: e.clientY };
    const node = e.target instanceof Element ? e.target.closest<HTMLElement>(`.card, ${CARD_BUTTONS}`) : null;
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
    // 焦点在托盘里的页或它页角的勾（data-card）上。
    const at = e.target instanceof Element ? e.target.closest<HTMLElement>(".card, .card-check") : null;
    const inTray = trayIds.size > 0 && trayIds.has(at?.dataset.id ?? at?.dataset.card ?? "");
    if (e.key === "Escape" && trayIds.size && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      // 托盘开着时（#418）：有选中的页先取消选择，再按一次关托盘。
      e.preventDefault();
      if (!dropTraySelection()) closeTray();
    } else if (chord && e.key.toLowerCase() === "a") {
      e.preventDefault();
      // 焦点在托盘里时只选中这一摞的全部页，不选中整面墙（#418）。
      if (inTray) onSelectionChange(new Set(ids.filter((id) => trayIds.has(id))));
      else selectAllRef.current();
    } else if (chord && e.key.toLowerCase() === "c" && onCardCommand) {
      // 复制：焦点在卡片上时按右键的同一选择规则；否则是当前选择。多张由调用方提示一次只能复制一张。
      const node = e.target instanceof Element ? e.target.closest<HTMLElement>(".card") : null;
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

  const dragStart = (id: string, e: DragEvent) => {
    // 拖未选中的图时只拖这一张，并改为选中它。
    let dragged = [...selected];
    if (!selected.has(id)) {
      dragged = [id];
      pivot.current = id;
      onSelectionChange(new Set(dragged));
    }
    // 拖的是整摞时（#418）放进文件夹的是它的全部页，与“移到文件夹”相同。
    const draggedPages = dragged.flatMap((id) => { const card = cards.find((c) => c.id === id); return card ? pagesOf([card]) : []; });
    const sourceIds = workspaceScope?.kind === "library"
      ? draggedPages.flatMap((c) => c.sources?.filter((s) => s.libraryId === workspaceScope.libraryId && !s.unavailable).map((s) => s.imageId) ?? [])
      : dragged.flatMap((id) => { const card = cards.find((c) => c.id === id); return card?.set ? card.set.pages.map((page) => page.id) : [id]; });
    e.dataTransfer.setData(DRAG_IMAGES, JSON.stringify(sourceIds));
    const bySource: Record<string, string[]> = {};
    for (const source of draggedPages.flatMap((c) => c.sources ?? [])) {
      if (!source.unavailable) (bySource[source.libraryId] ??= []).push(source.imageId);
    }
    e.dataTransfer.setData(DRAG_IMAGE_SOURCES, JSON.stringify(bySource));
    e.dataTransfer.effectAllowed = "copyMove";
  };
  /** 点托盘背景（#418）：只取消页的选择，托盘不关。 */
  const trayClick = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dropTraySelection();
  };
  /** 点托盘里页角的勾：增减这一页的选择，与 Ctrl 单击相同。 */
  const toggle = (card: BrowserCard) => select(card.id, { ctrlKey: true, shiftKey: false, metaKey: false });
  return { click, clearOnBlankClick, targetMenu, cardKey, wallKey, dragStart, trayClick, leaveTray, pruneTray, toggle };
}

/** Ctrl+V：从剪贴板导入（#105）。主窗口里焦点不在输入框、没有模态与查看器时都响应。 */
export function usePasteShortcut({ onPaste, viewerOpen, scroller }: {
  onPaste: (() => void) | undefined;
  viewerOpen: boolean;
  scroller: MutableRefObject<HTMLDivElement | null>;
}) {
  const pasteOnKey = useEffectEvent((e: globalThis.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "v" || e.defaultPrevented) return;
    const el = scroller.current;
    if (!onPaste || !el || viewerOpen || modalOpen() || el.closest("[hidden], [inert]") || editable(e.target)) return;
    e.preventDefault();
    onPaste();
  });
  useEffect(() => {
    document.addEventListener("keydown", pasteOnKey);
    return () => document.removeEventListener("keydown", pasteOnKey);
  }, []);
}
