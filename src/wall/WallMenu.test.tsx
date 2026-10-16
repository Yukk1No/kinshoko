import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MenuPopup } from "../ui/Menu";
import { WallMenu, type WallMenuActions, type WallMenuTarget } from "./WallMenu";
import type { BrowserCard } from "./Wall";
import type { BrowseScope } from "../bindings/BrowseScope";

afterEach(cleanup);

const card = (id: string, extra: Partial<BrowserCard> = {}): BrowserCard => ({
  id, width: 100, height: 100, thumbnail: `L1/${id}/256`, adult: false, libraryId: "L1", imageId: `i${id}`,
  sources: [{ libraryId: "L1", libraryName: "库一", imageId: `i${id}`, unavailable: null, matches: true, deleted: false }], ...extra,
});

function actions(): WallMenuActions {
  return {
    open: vi.fn(), pin: vi.fn(), crop: vi.fn(), edit: vi.fn(), addToGroup: vi.fn(), inspectSources: vi.fn(),
    purge: vi.fn(), importFrom: vi.fn(), selectAll: vi.fn(), setDensity: vi.fn(),
    folders: vi.fn(async () => [{ id: "f1", label: "人物" }]),
    groups: vi.fn(async () => [{ id: "g1", name: "光影", memberCount: 1, libraryIds: ["L1"], updatedAt: 0, problem: null }]),
  };
}

/** 菜单内容放在已打开的 ContextMenu 里渲染，与图片墙上的一样。 */
function show(target: WallMenuTarget, scope: BrowseScope = { kind: "all" }, a = actions()) {
  render(<ContextMenu.Root open><MenuPopup label="图片墙菜单"><WallMenu target={target} scope={scope} density={240} actions={a} /></MenuPopup></ContextMenu.Root>);
  const menu = screen.getByRole("menu");
  return { menu, a, rows: () => within(menu).getAllByRole("menuitem").map((row) => row.textContent) };
}
const point = { x: 50, y: 60 };

it("单张：菜单项与 #102 表一致（新能力项除外），快捷键提示在右侧，危险项置底红字", () => {
  const { menu, rows } = show({ kind: "cards", cards: [card("1")], point });
  expect(rows()).toEqual(["打开Enter", "钉住整图P", "框选局部钉住F1", "放入文件夹", "加入参考组", "内容分级", "移到回收站Del"]);
  const items = within(menu).getAllByRole("menuitem");
  expect(items.at(-1)!.className).toContain("is-danger");
  expect(items.filter((item) => item.className.includes("is-danger"))).toHaveLength(1);
  expect(within(menu).getAllByRole("separator")).toHaveLength(2);
});

it("单张：在文件夹范围里多出“从此文件夹移出”，多来源时多出“查看来源”", () => {
  const twoSources = card("1", { sources: [
    { libraryId: "L1", libraryName: "库一", imageId: "i1", unavailable: null, matches: true, deleted: false },
    { libraryId: "L2", libraryName: "库二", imageId: "j1", unavailable: null, matches: true, deleted: false },
  ] });
  const { rows, a } = show({ kind: "cards", cards: [twoSources], point }, { kind: "folder", id: "f9" });
  expect(rows()).toEqual(["打开Enter", "钉住整图P", "框选局部钉住F1", "放入文件夹", "从此文件夹移出", "加入参考组", "内容分级", "查看来源", "移到回收站Del"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "从此文件夹移出" }));
  expect(a.edit).toHaveBeenCalledWith([twoSources], [{ kind: "removeFromFolder", folderId: "f9" }], true);
});

it("单张：各项调用对应的动作", () => {
  const one = card("1");
  const { a } = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: /钉住整图/ }));
  expect(a.pin).toHaveBeenCalledWith([one], point);
  cleanup();
  const again = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: /框选局部钉住/ }));
  expect(again.a.crop).toHaveBeenCalledWith(one);
  cleanup();
  const third = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: /移到回收站/ }));
  expect(third.a.edit).toHaveBeenCalledWith([one], [{ kind: "delete" }], true);
});

it("多张：钉住 N 张、复制禁用并提示一次只能复制一张，回收站项带张数", () => {
  const cards = [card("1"), card("2"), card("3")];
  const { menu, rows, a } = show({ kind: "cards", cards, point });
  expect(rows()).toEqual(["钉住 3 张P", "复制一次只能复制一张", "放入文件夹", "加入参考组", "内容分级", "移到回收站（3 张）Del"]);
  const copy = within(menu).getByRole("menuitem", { name: /复制/ });
  expect(copy.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(copy);
  fireEvent.click(within(menu).getByRole("menuitem", { name: /钉住 3 张/ }));
  expect(a.pin).toHaveBeenCalledWith(cards, point);
  expect(within(menu).getAllByRole("menuitem").at(-1)!.className).toContain("is-danger");
});

it("回收站范围：还原与彻底删除，彻底删除置底", () => {
  const cards = [card("1"), card("2")];
  const { rows, a } = show({ kind: "cards", cards, point }, { kind: "trash" });
  expect(rows()).toEqual(["还原", "彻底删除…"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "还原" }));
  expect(a.edit).toHaveBeenCalledWith(cards, [{ kind: "restore" }], true);
  cleanup();
  const again = show({ kind: "cards", cards, point }, { kind: "trash" });
  const purge = screen.getByRole("menuitem", { name: "彻底删除…" });
  expect(purge.className).toContain("is-danger");
  fireEvent.click(purge);
  expect(again.a.purge).toHaveBeenCalledWith(cards);
});

it("空白处：导入、全选与图片大小", () => {
  const { rows, a } = show({ kind: "blank", point });
  expect(rows()).toEqual(["导入", "全选Ctrl A", "图片大小"]);
  fireEvent.click(screen.getByRole("menuitem", { name: /全选/ }));
  expect(a.selectAll).toHaveBeenCalled();
});

it("子菜单：放入文件夹列出图库的文件夹，内容分级写入分级", async () => {
  const one = card("1");
  const { a } = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: "放入文件夹" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "人物" }));
  expect(a.folders).toHaveBeenCalledWith("L1");
  expect(a.edit).toHaveBeenCalledWith([one], [{ kind: "addToFolder", folderId: "f1" }], false);
});

it("子菜单：内容分级与加入参考组", async () => {
  const one = card("1");
  const { a } = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: "内容分级" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "成人" }));
  expect(a.edit).toHaveBeenCalledWith([one], [{ kind: "setRating", rating: "explicit" }], false);
  cleanup();
  const again = show({ kind: "cards", cards: [one], point });
  fireEvent.click(screen.getByRole("menuitem", { name: "加入参考组" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "光影" }));
  expect(again.a.addToGroup).toHaveBeenCalledWith([one], "g1");
});

it("多张来自不同图库时放入文件夹不可用", () => {
  const { menu } = show({ kind: "cards", cards: [card("1"), card("2", { libraryId: "L2" })], point });
  const folders = within(menu).getByRole("menuitem", { name: /放入文件夹/ });
  expect(folders.getAttribute("aria-disabled")).toBe("true");
});

it("图片大小子菜单：几档预设，当前一档打勾，选中即提交", async () => {
  const { a } = show({ kind: "blank", point });
  fireEvent.click(screen.getByRole("menuitem", { name: "图片大小" }));
  const current = await screen.findByRole("menuitemradio", { name: "中" });
  expect(current.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "大" }));
  expect(a.setDensity).toHaveBeenCalledWith(320);
});

it("导入子菜单：图片文件、整个文件夹、从 Eagle", async () => {
  const { a } = show({ kind: "blank", point });
  fireEvent.click(screen.getByRole("menuitem", { name: "导入" }));
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(expect.arrayContaining(["图片文件…", "整个文件夹…", "从 Eagle…"]));
  fireEvent.click(screen.getByRole("menuitem", { name: "从 Eagle…" }));
  expect(a.importFrom).toHaveBeenCalledWith("eagle");
});
