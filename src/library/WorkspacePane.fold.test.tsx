// 子文件夹的折起（#608）：点有子文件夹的文件夹图标折起或展开，不选中这一行；← 折起、→ 展开；每个图库各记一份。
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { WorkspacePane } from "./WorkspacePane";
import { props, section, inA, loaded } from "./WorkspacePane.fixtures";

afterEach(() => localStorage.clear());

const parentItem = () => within(section("A")).getByRole("treeitem", { name: "人物" });
const child = () => within(section("A")).queryByRole("button", { name: "动作（1 张）" });

it("点图标折起、再点展开，不改正在看的范围；折起的状态记在本机", async () => {
  const view = await loaded();
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "unassigned" })} />);
  expect(parentItem().getAttribute("aria-expanded")).toBe("true");
  expect(child()).toBeTruthy();
  props.onScope.mockClear();
  fireEvent.click(parentItem().querySelector(".k-fold")!);
  expect(parentItem().getAttribute("aria-expanded")).toBe("false");
  expect(child()).toBeNull();
  expect(props.onScope).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem("kinshoko.sidebar.folded.A") ?? "[]")).toEqual(["A-root"]);
  fireEvent.click(parentItem().querySelector(".k-fold")!);
  expect(child()).toBeTruthy();
});

it("键盘：← 折起，→ 展开；折起的分支里有选中的文件夹时，上面那一层标出来", async () => {
  const view = await loaded();
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "folder", id: "A-child" })} />);
  const row = within(parentItem()).getAllByRole("button")[0];
  expect(parentItem().hasAttribute("data-branch")).toBe(true);
  fireEvent.keyDown(row, { key: "ArrowLeft" });
  expect(child()).toBeNull();
  expect(parentItem().hasAttribute("data-branch")).toBe(true);
  fireEvent.keyDown(row, { key: "ArrowRight" });
  expect(child()).toBeTruthy();
});

it("选中的文件夹在折起的分支里时，从图库菜单新建文件夹：沿路先展开，名字输入框看得见", async () => {
  localStorage.setItem("kinshoko.sidebar.folded.A", JSON.stringify(["A-root"]));
  const view = await loaded();
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "folder", id: "A-child" })} />);
  expect(child()).toBeNull();
  fireEvent.click(within(section("A")).getByRole("button", { name: "人物参考 的操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "新建文件夹" }));
  expect(within(section("A")).getByRole("textbox", { name: "新文件夹名称" })).toBeTruthy();
  expect(child()).toBeTruthy();
});
