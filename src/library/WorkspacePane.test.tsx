import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspacePane } from "./WorkspacePane";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES } from "../wall/Wall";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
const registrations = ["A", "B"].map((id) => ({ library: { id, name: "参考", root: `D:\\${id}\\参考` }, unavailable: null }));
const forest = (revision = "r"): WorkspaceDirectories => ({ status: { revision, libraries: registrations }, providers: registrations.map((registration) => ({ registration: { ...registration, library: { ...registration.library } }, unassigned: 1, descendants: { [registration.library.id + "-root"]: 2, [registration.library.id + "-child"]: 1 }, sidebar: { all: 3, trash: 0, folders: [{ id: registration.library.id + "-root", name: "人物", count: 1, children: [{ id: registration.library.id + "-child", name: "动作", count: 1, children: [] }] }] } })) });
let pending: { safeMode: boolean; resolve: (value: WorkspaceDirectories) => void; reject: (error: unknown) => void }[];
const props = { status: { revision: "r", libraries: registrations }, scope: { kind: "all" } as WorkspaceScope, activeLibraryId: "B", safeMode: true, reloadKey: 0, onScope: vi.fn(), onError: vi.fn() };
const settle = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  pending = [];
  props.onScope.mockClear(); props.onError.mockClear();
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    throw new Error(command);
  });
});
afterEach(() => { cleanup(); clearMocks(); });
it("每库为独立根展示完整目录，选择目录默认包含子文件夹，明确切换直接层级", async () => {
  const view = render(<WorkspacePane {...props} />);
  await settle();
  expect(pending).toHaveLength(1);
  await act(async () => pending[0].resolve(forest()));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  const b = document.querySelector<HTMLElement>('[data-library-id="B"]')!;
  expect(within(a).getByText("D:\\A\\参考")).toBeTruthy();
  expect(within(b).getByText("D:\\B\\参考")).toBeTruthy();
  expect(within(a).getByRole("button", { name: "人物（2 张）" })).toBeTruthy();
  fireEvent.click(within(a).getByRole("button", { name: "动作（1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "folderTree", id: "A-child" } });
  view.rerender(<WorkspacePane {...props} scope={{ kind: "library", libraryId: "A", scope: { kind: "folderTree", id: "A-root" } }} />);
  const descendants = screen.getByRole("switch", { name: "含子文件夹" });
  expect(descendants.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(descendants);
  expect(within(a).getByRole("button", { name: "人物（1 张）" })).toBeTruthy();
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "folder", id: "A-root" } });
  fireEvent.click(within(b).getByRole("button", { name: "动作（1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "B", scope: { kind: "folder", id: "B-child" } });
});
it("每个已连接图库的目录都可以直接整理，请求带上该图库的身份（ADR-0008，#112）", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    if (command === "plugin:library|create_folder") return "new-folder";
    return null;
  });
  render(<WorkspacePane {...props} activeLibraryId="B" />);
  await settle();
  await act(async () => pending[0].resolve(forest()));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  const add = within(a).getByRole("button", { name: "新建文件夹" });
  expect(add).toHaveProperty("disabled", false);
  expect(within(a).getByRole("button", { name: "人物（2 张）" }).getAttribute("draggable")).toBe("true");
  fireEvent.click(add);
  const input = within(a).getByRole("textbox", { name: "新文件夹名称" });
  fireEvent.change(input, { target: { value: "姿势" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  fireEvent.doubleClick(within(a).getByRole("button", { name: "动作（1 张）" }));
  const rename = within(a).getByRole("textbox", { name: "文件夹名称" });
  fireEvent.change(rename, { target: { value: "跑跳" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  await settle();
  expect(calls).toEqual([
    { command: "plugin:library|create_folder", args: { libraryId: "A", name: "姿势", parent: null } },
    { command: "plugin:library|rename_folder", args: { libraryId: "A", folderId: "A-child", name: "跑跳" } },
  ]);
  expect(props.onError).not.toHaveBeenCalled();
});
it("把图拖进任一图库的文件夹，放入的是这张图在那个图库里的来源（#112）", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    return [];
  });
  render(<WorkspacePane {...props} activeLibraryId="B" />);
  await settle();
  await act(async () => pending[0].resolve(forest()));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  const data: Record<string, string> = {
    [DRAG_IMAGES]: JSON.stringify(["card-1", "card-2"]),
    [DRAG_IMAGE_SOURCES]: JSON.stringify({ A: ["a-1"], B: ["b-1", "b-2"] }),
  };
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? "" };
  const folder = within(a).getByRole("button", { name: "动作（1 张）" });
  fireEvent.dragOver(folder, { dataTransfer });
  fireEvent.drop(folder, { dataTransfer });
  await settle();
  expect(calls).toEqual([
    { command: "plugin:library|edit", args: { libraryId: "A", ids: ["a-1"], edits: [{ kind: "addToFolder", folderId: "A-child" }] } },
  ]);
});
it("目录响应迟到时不替换新代次，当前范围保持明确身份", async () => {
  const selected: WorkspaceScope = { kind: "library", libraryId: "A", scope: { kind: "folderTree", id: "A-root" } };
  const view = render(<WorkspacePane {...props} scope={selected} />);
  await settle();
  view.rerender(<WorkspacePane {...props} scope={selected} safeMode={false} reloadKey={1} status={{ ...props.status, revision: "new" }} />);
  await settle();
  const fresh = forest("new");
  fresh.providers[0].sidebar!.folders[0].name = "新目录";
  await act(async () => pending[1].resolve(fresh));
  await act(async () => pending[0].resolve(forest("old")));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  expect(within(a).queryByRole("button", { name: "人物（2 张）" })).toBeNull();
  expect(within(a).getByRole("button", { name: "新目录（2 张）" })).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
  expect(pending[1].safeMode).toBe(false);
});
it("断连库与失效文件夹保持原范围并禁用旧目录控件", async () => {
  const selected: WorkspaceScope = { kind: "library", libraryId: "A", scope: { kind: "folderTree", id: "A-root" } };
  const view = render(<WorkspacePane {...props} scope={selected} />);
  await settle();
  await act(async () => pending[0].resolve(forest()));
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={1} />);
  expect(screen.queryByRole("button", { name: "动作（1 张）" })).toBeNull();
  const gone = forest("gone");
  gone.providers[0].sidebar!.folders = [];
  await act(async () => pending[1].resolve(gone));
  expect(screen.getByText("范围：参考 / 文件夹已失效")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "含子文件夹" }).hasAttribute("data-disabled")).toBe(true);
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={2} />);
  const missing = forest("missing");
  missing.providers[0].registration.unavailable = "未连接";
  missing.providers[0].sidebar = null;
  await act(async () => pending[2].resolve(missing));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  expect(within(a).getByRole("button", { name: "参考（未连接）" })).toHaveProperty("disabled", true);
  expect(screen.getByText("范围：参考 / 未连接")).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
});

it("读取时目录修订改变会自动重读，不留下要求用户操作的过期提示", async () => {
  render(<WorkspacePane {...props} />);
  await settle();
  await act(async () => pending[0].reject("浏览结果已变化，请从头重新浏览"));
  await settle();
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(forest("fresh")));
  expect(document.querySelectorAll("[data-folder-id]")).toHaveLength(4);
  expect(props.onError).not.toHaveBeenCalled();
});

it("同名库的长路径优先显示区分位置，仅驱动器不同的路径仍保留差异", async () => {
  const value = forest("paths");
  value.providers[0].registration = { ...value.providers[0].registration, library: { ...value.providers[0].registration.library, root: "C:\\Users\\Owner\\Libraries\\a\\参考" } };
  value.providers[1].registration = { ...value.providers[1].registration, library: { ...value.providers[1].registration.library, root: "C:\\Users\\Owner\\Libraries\\b\\参考" } };
  const view = render(<WorkspacePane {...props} />);
  await settle();
  await act(async () => pending[0].resolve(value));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  const b = document.querySelector<HTMLElement>('[data-library-id="B"]')!;
  expect(within(a).getByText("…\\a\\参考").title).toBe(value.providers[0].registration.library.root);
  expect(within(b).getByText("…\\b\\参考").title).toBe(value.providers[1].registration.library.root);
  view.rerender(<WorkspacePane {...props} reloadKey={1} />);
  const drives = forest("drives");
  drives.providers[0].registration = { ...drives.providers[0].registration, library: { ...drives.providers[0].registration.library, root: "C:/Users/Owner/Libraries/same/参考" } };
  drives.providers[1].registration = { ...drives.providers[1].registration, library: { ...drives.providers[1].registration.library, root: "D:/Users/Owner/Libraries/same/参考" } };
  await act(async () => pending[1].resolve(drives));
  expect(within(a).getByText("C:/Users/Owner/Libraries/same/参考").title).toBe(drives.providers[0].registration.library.root);
  expect(within(b).getByText("D:/Users/Owner/Libraries/same/参考").title).toBe(drives.providers[1].registration.library.root);
});

it("未连接的图库就地说明原因，“重新连接”重新检查", async () => {
  const recheck = vi.fn();
  render(<WorkspacePane {...props} onRecheck={recheck} />);
  await settle();
  const missing = forest("offline");
  missing.providers[0].registration.unavailable = "资料库暂时不可用：移动盘没插";
  missing.providers[0].sidebar = null;
  await act(async () => pending[0].resolve(missing));
  const a = document.querySelector<HTMLElement>('[data-library-id="A"]')!;
  const card = within(a).getByRole("status");
  expect(card.textContent).toContain("找不到这个图库");
  expect(card.textContent).toContain("移动盘没插");
  fireEvent.click(within(card).getByRole("button", { name: "重新连接" }));
  expect(recheck).toHaveBeenCalledTimes(1);
  expect(within(document.querySelector<HTMLElement>('[data-library-id="B"]')!).queryByRole("button", { name: "重新连接" })).toBeNull();
});
it("回收站只在侧栏底部出现一次，跟随正在查看的那个图库的回收站（#98 侧栏三段）", async () => {
  const view = render(<WorkspacePane {...props} />);
  await settle();
  const two = forest(); two.providers[0].sidebar!.trash = 4; two.providers[1].sidebar!.trash = 2;
  await act(async () => pending[0].resolve(two));
  const trash = screen.getAllByRole("button", { name: /^回收站（/ });
  expect(trash).toHaveLength(1);
  expect(trash[0].closest(".side-foot")).toBeTruthy();
  expect(trash[0].getAttribute("aria-label")).toBe("回收站（2 张）");
  fireEvent.click(trash[0]);
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "B", scope: { kind: "trash" } });
  // Opening another library's trash (e.g. 去回收站 on its import receipt) uses the same bottom entry.
  view.rerender(<WorkspacePane {...props} scope={{ kind: "library", libraryId: "A", scope: { kind: "trash" } }} />);
  const shown = screen.getAllByRole("button", { name: /^回收站（/ });
  expect(shown).toHaveLength(1);
  expect(shown[0].getAttribute("aria-label")).toBe("回收站（4 张）");
  expect(shown[0].getAttribute("aria-current")).toBe("page");
});
