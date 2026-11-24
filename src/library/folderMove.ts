// 左栏文件夹拖动排顺序（#636）里不碰界面的部分：指针停在哪里算放到哪里、Alt + 方向键挪到哪里、挪完读给读屏用户的位置。
import type { FolderNode } from "../bindings/FolderNode";

/** 移动文件夹时放到新位置的最后。 */
export const LAST = 2 ** 31;

/** 拖动时看得见的一行文件夹：深度从 0 起，top 与 height 是屏幕上的位置（按“拿起的那一支已经合上”算）。 */
export type DragRow = { id: string; depth: number; parent: string | null; top: number; height: number };

/** 放到哪里：两行之间的一道缝（排到某一层的第几个），或者放进某个文件夹（排在最后）。 */
export type DropAim =
  | { kind: "gap"; gap: number; depth: number; parent: string | null; position: number }
  | { kind: "into"; row: number };

/** 一行的中段（高度的 25%–75%）停一会儿算放进去；上下两段算这一行上面或下面的缝。 */
export const INTO_BAND = [0.25, 0.75] as const;

/** 指针在第几行、在这一行的什么高度（0–1）。在所有行上下留一点余地，再往外就不算落点。 */
export function rowAt(rows: DragRow[], y: number): { row: number; part: number } | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (y < first.top - 24 || y > last.top + last.height + 36) return null;
  let row = rows.findIndex((r) => y < r.top + r.height);
  if (row < 0) row = rows.length - 1;
  return { row, part: Math.min(1, Math.max(0, (y - rows[row].top) / rows[row].height)) };
}

/**
 * 第 gap 道缝（rows[gap - 1] 与 rows[gap] 之间）放在哪一层。同一道缝可以属于几层（一组的末尾，或者外面一层）：
 * 默认留在拿起时的那一层 `home`，往左带一层就到外面一层（`shift` 是往右带了几层，负数是往左）。
 */
export function gapAim(rows: DragRow[], gap: number, home: number, shift: number): DropAim {
  const next = gap < rows.length ? rows[gap].depth : 0;
  const before = gap > 0 ? rows[gap - 1].depth : 0;
  const depth = Math.max(next, Math.min(Math.max(next, before), home + shift));
  let parent: string | null = null;
  for (let index = gap - 1; depth > 0 && index >= 0; index--)
    if (rows[index].depth === depth - 1) {
      parent = rows[index].id;
      break;
    }
  const position = rows.slice(0, gap).filter((row) => row.parent === parent).length;
  return { kind: "gap", gap, depth, parent, position };
}

/** 两个落点是不是同一个（线不用挪）。 */
export function sameAim(a: DropAim | null, b: DropAim | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "gap" && b.kind === "gap") return a.gap === b.gap && a.depth === b.depth;
  if (a.kind === "into" && b.kind === "into") return a.row === b.row;
  return false;
}

/** 文件夹在树里的父文件夹（null 为最外面一层）、同级的各个文件夹。找不到为 undefined。 */
export function locate(
  nodes: FolderNode[],
  id: string,
  parent: FolderNode | null = null,
): { parent: FolderNode | null; siblings: FolderNode[] } | undefined {
  for (const node of nodes) {
    if (node.id === id) return { parent, siblings: nodes };
    const found = locate(node.children, id, node);
    if (found) return found;
  }
  return undefined;
}

export type FolderMove = { parent: string | null; position: number };

/**
 * 键盘挪文件夹：Alt + ↑ ↓ 在同级里挪一格，Alt + → 放进上一个文件夹（排在最后），Alt + ← 移到外面一层（排在原来那个父文件夹后面）。
 * 挪不动（已经在最上、最下、最外面，或前面没有文件夹）时为 null。
 */
export function keyMove(nodes: FolderNode[], id: string, key: string): FolderMove | null {
  const at = locate(nodes, id);
  if (!at) return null;
  const index = at.siblings.findIndex((node) => node.id === id);
  const parent = at.parent?.id ?? null;
  switch (key) {
    case "ArrowUp":
      return index > 0 ? { parent, position: index - 1 } : null;
    case "ArrowDown":
      return index < at.siblings.length - 1 ? { parent, position: index + 1 } : null;
    case "ArrowRight":
      return index > 0 ? { parent: at.siblings[index - 1].id, position: LAST } : null;
    case "ArrowLeft": {
      if (!at.parent) return null;
      const outer = locate(nodes, at.parent.id);
      if (!outer) return null;
      return { parent: outer.parent?.id ?? null, position: outer.siblings.indexOf(at.parent) + 1 };
    }
    default:
      return null;
  }
}

/** 挪完以后它在新的一层里是第几个（从 1 起），与后端 `move_folder` 的算法一致：先从原来的位置拿走，再插进去。 */
export function placeAfter(nodes: FolderNode[], id: string, move: FolderMove): number {
  const inside =
    move.parent === null ? nodes : locate(nodes, move.parent)?.siblings.find((n) => n.id === move.parent)?.children;
  const others = (inside ?? []).filter((node) => node.id !== id).length;
  return Math.min(move.position, others) + 1;
}
