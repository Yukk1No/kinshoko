import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspacePane } from "./WorkspacePane";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowseScope } from "../bindings/BrowseScope";

// 侧栏右键菜单（#102 表“侧栏”三行，#114）：文件夹、图库标题与回收站。
const names: Record<string, string> = { A: "人物参考", B: "风景参考" };
const registrations = ["A", "B"].map((id) => ({ library: { id, name: names[id], root: `D:\\${id}\\参考` }, unavailable: null as string | null }));
const forest = (): WorkspaceDirectories => ({ status: { revision: "r", libraries: registrations }, providers: registrations.map((registration) => ({ registration: { ...registration, library: { ...registration.library } }, unassigned: 1, descendants: {}, sidebar: { all: 3, trash: 2, folders: [{ id: registration.library.id + "-root", name: "人物", count: 1, children: [{ id: registration.library.id + "-child", name: "动作", count: 1, children: [] }] }] } })) });
const inA = (local: BrowseScope): WorkspaceScope => ({ kind: "library", libraryId: "A", scope: local });
const section = (id: string) => document.querySelector<HTMLElement>(`[data-library-id="${id}"]`)!;
const settle = () => act(async () => { await Promise.resolve(); });
const rows = (menu: HTMLElement) => [...menu.querySelectorAll("[role^='menuitem']")].map((row) => row.textContent);
const enabled = (menu: HTMLElement, name: string) => within(menu).getByRole("menuitem", { name }).getAttribute("aria-disabled") !== "true";

let calls: { command: string; args: Record<string, unknown> }[];
let answers: Record<string, unknown>;
const onScope = vi.fn();
const onError = vi.fn();
beforeEach(() => {
  calls = [];
  answers = {};
  onScope.mockClear(); onError.mockClear();
});
afterEach(() => { cleanup(); clearMocks(); });

async function show(scope: WorkspaceScope, value = forest(), extra: Partial<Parameters<typeof WorkspacePane>[0]> = {}) {
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return value;
    calls.push({ command, args: args as Record<string, unknown> });
    const answer = answers[command];
    if (answer instanceof Error) throw answer.message;
    return answer ?? null;
  });
  const view = render(<WorkspacePane status={{ revision: "r", libraries: registrations }} scope={scope} safeMode reloadKey={0} onScope={onScope} onError={onError} {...extra} />);
  await settle(); await settle();
  return view;
}
const openOn = async (node: HTMLElement, label: string) => {
  fireEvent.contextMenu(node, { clientX: 20, clientY: 20 });
  return screen.findByRole("menu", { name: label });
};

it("图库标题：右键与 ⋯ 是同一组菜单项；未连接时多出“重新连接”", async () => {
  const offline = forest();
  offline.providers[1].registration.unavailable = "资料库暂时不可用：移动盘没插";
  offline.providers[1].sidebar = null;
  await show({ kind: "all" }, offline, { onRecheck: vi.fn() });
  const head = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  const viaRightClick = await openOn(head, "人物参考 的操作");
  expect(rows(viaRightClick)).toEqual(["新建文件夹", "在资源管理器中打开", "从列表移除"]);
  expect(within(viaRightClick).getAllByRole("separator")).toHaveLength(1);
  fireEvent.keyDown(viaRightClick, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(within(section("A")).getByRole("button", { name: "人物参考 的操作" }));
  expect(rows(await screen.findByRole("menu", { name: "人物参考 的操作" }))).toEqual(["新建文件夹", "在资源管理器中打开", "从列表移除"]);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  const off = await openOn(within(section("B")).getByRole("button", { name: "风景参考（未连接）" }), "风景参考 的操作");
  expect(rows(off)).toEqual(["新建文件夹", "在资源管理器中打开", "重新连接", "从列表移除"]);
  expect(enabled(off, "新建文件夹")).toBe(false);
});

it("图库标题：在资源管理器中打开、重新连接与从列表移除", async () => {
  const offline = forest();
  offline.providers[1].registration.unavailable = "未连接";
  offline.providers[1].sidebar = null;
  const onRecheck = vi.fn();
  const onRemoved = vi.fn();
  await show({ kind: "all" }, offline, { onRecheck, onRemoved });
  const headA = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  fireEvent.click(within(await openOn(headA, "人物参考 的操作")).getByRole("menuitem", { name: "在资源管理器中打开" }));
  await settle();
  expect(calls).toEqual([{ command: "plugin:desktop|reveal_library", args: { libraryId: "A" } }]);

  answers["plugin:desktop|reveal_library"] = new Error("资料库暂时不可用：D:\\A\\参考");
  fireEvent.click(within(await openOn(headA, "人物参考 的操作")).getByRole("menuitem", { name: "在资源管理器中打开" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("无法在资源管理器中打开：资料库暂时不可用：D:\\A\\参考"));

  const headB = within(section("B")).getByRole("button", { name: "风景参考（未连接）" });
  fireEvent.click(within(await openOn(headB, "风景参考 的操作")).getByRole("menuitem", { name: "重新连接" }));
  expect(onRecheck).toHaveBeenCalledTimes(1);

  calls = [];
  fireEvent.click(within(await openOn(headB, "风景参考 的操作")).getByRole("menuitem", { name: "从列表移除" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("B"));
  expect(calls).toEqual([{ command: "plugin:library|unregister_library", args: { libraryId: "B" } }]);
});

it("移除当前范围所在的图库后回到“全部图片”；移除别的图库或移除失败时范围不变", async () => {
  const onRemoved = vi.fn();
  await show(inA({ kind: "folderTree", id: "A-root" }), forest(), { onRemoved });
  const headB = within(section("B")).getByRole("button", { name: "风景参考（3 张）" });
  fireEvent.click(within(await openOn(headB, "风景参考 的操作")).getByRole("menuitem", { name: "从列表移除" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("B"));
  expect(onScope).not.toHaveBeenCalled();

  const headA = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  answers["plugin:library|unregister_library"] = new Error("还有导入在进行");
  fireEvent.click(within(await openOn(headA, "人物参考 的操作")).getByRole("menuitem", { name: "从列表移除" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("还有导入在进行"));
  expect(onScope).not.toHaveBeenCalled();

  delete answers["plugin:library|unregister_library"];
  fireEvent.click(within(await openOn(headA, "人物参考 的操作")).getByRole("menuitem", { name: "从列表移除" }));
  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("A"));
  expect(onScope).toHaveBeenCalledWith({ kind: "all" });
});

it("文件夹：菜单项与表一致，顶层文件夹不能“移到顶层”；菜单键打开同一菜单", async () => {
  await show(inA({ kind: "all" }));
  const top = within(section("A")).getByRole("button", { name: "人物（1 张）" });
  const menu = await openOn(top, "人物 的操作");
  expect(rows(menu)).toEqual(["新建子文件夹", "重命名F2", "移到顶层", "删除文件夹…"]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  expect(enabled(menu, "移到顶层")).toBe(false);
  const danger = within(menu).getAllByRole("menuitem").filter((item) => item.className.includes("is-danger"));
  expect(danger.map((item) => item.textContent)).toEqual(["删除文件夹…"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  const child = within(section("A")).getByRole("button", { name: "动作（1 张）" });
  fireEvent.keyDown(child, { key: "F10", shiftKey: true });
  const childMenu = await screen.findByRole("menu", { name: "动作 的操作" });
  fireEvent.click(within(childMenu).getByRole("menuitem", { name: "移到顶层" }));
  await settle();
  expect(calls).toEqual([{ command: "plugin:library|move_folder", args: { libraryId: "A", folderId: "A-child", parent: null, position: 2 ** 31 } }]);
});

it("文件夹：新建子文件夹建在它里面；重命名可从菜单或按 F2", async () => {
  await show(inA({ kind: "all" }));
  const top = () => within(section("A")).getByRole("button", { name: "人物（1 张）" });
  fireEvent.click(within(await openOn(top(), "人物 的操作")).getByRole("menuitem", { name: "新建子文件夹" }));
  const input = await within(section("A")).findByRole("textbox", { name: "新文件夹名称" });
  fireEvent.change(input, { target: { value: "姿势" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();

  fireEvent.click(within(await openOn(top(), "人物 的操作")).getByRole("menuitem", { name: /^重命名/ }));
  const rename = await within(section("A")).findByRole("textbox", { name: "文件夹名称" });
  fireEvent.change(rename, { target: { value: "角色" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  await settle();

  fireEvent.keyDown(within(section("A")).getByRole("button", { name: "动作（1 张）" }), { key: "F2" });
  const again = within(section("A")).getByRole("textbox", { name: "文件夹名称" });
  fireEvent.change(again, { target: { value: "跑跳" } });
  fireEvent.keyDown(again, { key: "Enter" });
  await settle();
  expect(calls).toEqual([
    { command: "plugin:library|create_folder", args: { libraryId: "A", name: "姿势", parent: "A-root" } },
    { command: "plugin:library|rename_folder", args: { libraryId: "A", folderId: "A-root", name: "角色" } },
    { command: "plugin:library|rename_folder", args: { libraryId: "A", folderId: "A-child", name: "跑跳" } },
  ]);
});

it("删除文件夹先确认，写明图片不删、子文件夹一并删除；正在看的文件夹被删后回到该图库的全部", async () => {
  await show(inA({ kind: "folderTree", id: "A-child" }));
  const top = within(section("A")).getByRole("button", { name: "人物（1 张）" });
  fireEvent.click(within(await openOn(top, "人物 的操作")).getByRole("menuitem", { name: "删除文件夹…" }));
  let dialog = await screen.findByRole("alertdialog", { name: "删除文件夹" });
  expect(dialog.textContent).toContain("删除文件夹「人物」？");
  expect(dialog.textContent).toContain("图片不会删除");
  expect(dialog.textContent).toContain("回到未归类");
  expect(dialog.textContent).toContain("1 个子文件夹也会一并删除");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(calls).toEqual([]);

  fireEvent.click(within(await openOn(top, "人物 的操作")).getByRole("menuitem", { name: "删除文件夹…" }));
  dialog = await screen.findByRole("alertdialog", { name: "删除文件夹" });
  fireEvent.click(within(dialog).getByRole("button", { name: "删除文件夹" }));
  await waitFor(() => expect(calls).toEqual([{ command: "plugin:library|delete_folder", args: { libraryId: "A", folderId: "A-root" } }]));
  await waitFor(() => expect(onScope).toHaveBeenLastCalledWith(inA({ kind: "all" })));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("没有子文件夹的文件夹：确认框不提子文件夹", async () => {
  await show(inA({ kind: "all" }));
  fireEvent.click(within(await openOn(within(section("A")).getByRole("button", { name: "动作（1 张）" }), "动作 的操作")).getByRole("menuitem", { name: "删除文件夹…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "删除文件夹" });
  expect(dialog.textContent).not.toContain("子文件夹");
});

it("回收站：清空回收站先列出将永久删除的张数，确认后按预览的令牌删除", async () => {
  answers["plugin:library|preview_empty_trash"] = { imageIds: ["x", "y"], groups: [{ groupId: "g", name: "光影", imageIds: ["x"] }], token: "t" };
  await show(inA({ kind: "all" }));
  const trash = screen.getByRole("button", { name: "回收站 · 人物参考（2 张）" });
  const menu = await openOn(trash, "回收站的操作");
  expect(rows(menu)).toEqual(["清空回收站…"]);
  expect(within(menu).getByRole("menuitem").className).toContain("is-danger");
  fireEvent.click(within(menu).getByRole("menuitem"));
  const dialog = await screen.findByRole("alertdialog", { name: "清空回收站" });
  await waitFor(() => expect(dialog.textContent).toContain("永久删除「人物参考」回收站里的 2 张图？"));
  expect(within(dialog).getByRole("list", { name: "受影响的参考组" }).textContent).toContain("光影（1 张）");
  expect(calls).toEqual([{ command: "plugin:library|preview_empty_trash", args: { libraryId: "A" } }]);
  fireEvent.click(within(dialog).getByRole("button", { name: "清空回收站" }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ command: "plugin:library|permanent_delete", args: { libraryId: "A", ids: ["x", "y"], token: "t" } }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("回收站：空的回收站不能清空；“全部图片”下按图库各给一项", async () => {
  const value = forest();
  value.providers[1].sidebar!.trash = 0;
  await show({ kind: "all" }, value);
  const menu = await openOn(screen.getByRole("button", { name: "回收站 · 全部图库（2 张）" }), "回收站的操作");
  expect(rows(menu)).toEqual(["清空「人物参考」的回收站…", "清空「风景参考」的回收站…"]);
  expect(enabled(menu, "清空「人物参考」的回收站…")).toBe(true);
  expect(enabled(menu, "清空「风景参考」的回收站…")).toBe(false);
});
