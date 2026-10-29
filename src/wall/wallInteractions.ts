// 图片墙上的选择、键盘、右键与拖出，以及 Ctrl+V 导入（#105），从 Wall.tsx 原样搬出。
import { useEffect, useRef } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { modalOpen } from "../ui/modal";
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import type { Press } from "./doubleClick";
import type { WallMenuTarget } from "./WallMenu";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES, editable, type BrowserCard, type CardCommand } from "./wallShared";

export function wallInteractions({
  ids, cards, selected, onSelectionChange, pivot, lastPress, pendingClick, holdForDoubleClick, open, selectAllRef,
  setMenuTarget, menu, onCardCommand, scope, workspaceScope,
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
}) {
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


  /**
   * 单击卡片（#179）：未选中的只选中它；当前唯一选中的那张打开查看器；多选中不按修饰键单击其中一张，
   * 选择收缩为这一张（资源管理器的习惯）。这一下记作双击的第一下。
   */
  const click = (card: BrowserCard, e: MouseEvent) => {
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
    if (e.ctrlKey || e.metaKey || e.shiftKey || !selected.size) return;
    if ((e.target as Element).closest?.(".card, .card-sources")) return;
    const el = e.currentTarget;
    if (e.clientX - el.getBoundingClientRect().left >= el.clientWidth) return;
    onSelectionChange(new Set());
  };
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
  return { click, clearOnBlankClick, targetMenu, cardKey, wallKey, dragStart };
}

/** Ctrl+V：从剪贴板导入（#105）。主窗口里焦点不在输入框、没有模态与查看器时都响应。 */
export function usePasteShortcut({ onPaste, viewerOpen, scroller }: {
  onPaste: (() => void) | undefined;
  viewerOpen: boolean;
  scroller: MutableRefObject<HTMLDivElement | null>;
}) {
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
}
