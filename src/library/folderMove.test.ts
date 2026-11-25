import { expect, it } from "vitest";
import type { FolderNode } from "../bindings/FolderNode";
import { gapAim, keyMove, LAST, placeAfter, rowAt, type DragRow } from "./folderMove";

const node = (id: string, children: FolderNode[] = []): FolderNode => ({ id, name: id, count: 0, children });
// 人物（发型、表情）、服装、背景
const folders = [node("人物", [node("发型"), node("表情")]), node("服装"), node("背景")];

/** 拿起“背景”之后看得见的各行，每行 30 px。 */
const rows: DragRow[] = [
  { id: "人物", depth: 0, parent: null },
  { id: "发型", depth: 1, parent: "人物" },
  { id: "表情", depth: 1, parent: "人物" },
  { id: "服装", depth: 0, parent: null },
].map((row, index) => ({ ...row, top: index * 30, height: 30 }));

it("指针在哪一行的什么高度；离所有行太远时不算落点", () => {
  expect(rowAt(rows, 45)).toEqual({ row: 1, part: 0.5 });
  expect(rowAt(rows, -10)).toEqual({ row: 0, part: 0 });
  expect(rowAt(rows, -30)).toBeNull();
  expect(rowAt(rows, 200)).toBeNull();
});

it("同一道缝默认留在拿起时的那一层，往左右带一带换层", () => {
  // “表情”与“服装”之间：可以是“人物”里的最后，也可以是外面一层“服装”前面。
  expect(gapAim(rows, 3, 1, 0)).toMatchObject({ depth: 1, parent: "人物", position: 2 });
  expect(gapAim(rows, 3, 1, -1)).toMatchObject({ depth: 0, parent: null, position: 1 });
  expect(gapAim(rows, 3, 0, 0)).toMatchObject({ depth: 0, parent: null, position: 1 });
  expect(gapAim(rows, 3, 0, 1)).toMatchObject({ depth: 1, parent: "人物", position: 2 });
  // “发型”与“表情”之间只属于一层：怎么带都在“人物”里。
  expect(gapAim(rows, 2, 0, -3)).toMatchObject({ depth: 1, parent: "人物", position: 1 });
  expect(gapAim(rows, 2, 0, 3)).toMatchObject({ depth: 1, parent: "人物", position: 1 });
  // 最上面：最外面一层第一个。
  expect(gapAim(rows, 0, 1, 0)).toMatchObject({ depth: 0, parent: null, position: 0 });
});

it("Alt + 方向键：同级挪一格、放进上一个、移到外面一层", () => {
  expect(keyMove(folders, "服装", "ArrowUp")).toEqual({ parent: null, position: 0 });
  expect(keyMove(folders, "服装", "ArrowDown")).toEqual({ parent: null, position: 2 });
  expect(keyMove(folders, "背景", "ArrowDown")).toBeNull();
  expect(keyMove(folders, "人物", "ArrowUp")).toBeNull();
  expect(keyMove(folders, "服装", "ArrowRight")).toEqual({ parent: "人物", position: LAST });
  expect(keyMove(folders, "人物", "ArrowRight")).toBeNull();
  expect(keyMove(folders, "表情", "ArrowLeft")).toEqual({ parent: null, position: 1 });
  expect(keyMove(folders, "服装", "ArrowLeft")).toBeNull();
});

it("挪完以后是新的一层里的第几个", () => {
  expect(placeAfter(folders, "服装", { parent: "人物", position: LAST })).toBe(3);
  expect(placeAfter(folders, "表情", { parent: null, position: 1 })).toBe(2);
  expect(placeAfter(folders, "背景", { parent: null, position: 0 })).toBe(1);
  expect(placeAfter(folders, "人物", { parent: null, position: LAST })).toBe(3);
});
