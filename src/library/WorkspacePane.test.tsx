import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { WorkspacePane } from "./WorkspacePane";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES } from "../wall/Wall";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { BrowseScope } from "../bindings/BrowseScope";
const names: Record<string, string> = { A: "人物参考", B: "风景参考" };
const registrations = ["A", "B"].map((id) => ({ library: { id, name: names[id], root: `D:\\${id}\\参考` }, unavailable: null as string | null }));
const forest = (revision = "r"): WorkspaceDirectories => ({ status: { revision, libraries: registrations }, providers: registrations.map((registration) => ({ registration: { ...registration, library: { ...registration.library } }, unassigned: 1, descendants: { [registration.library.id + "-root"]: 2, [registration.library.id + "-child"]: 1 }, sidebar: { all: 3, trash: 0, folders: [{ id: registration.library.id + "-root", name: "人物", count: 1, children: [{ id: registration.library.id + "-child", name: "动作", count: 1, children: [] }] }] } })) });
let pending: { safeMode: boolean; resolve: (value: WorkspaceDirectories) => void; reject: (error: unknown) => void }[];
const props = { status: { revision: "r", libraries: registrations }, scope: { kind: "all" } as WorkspaceScope, safeMode: true, reloadKey: 0, onScope: vi.fn(), onError: vi.fn() };
const settle = () => act(async () => { await Promise.resolve(); });
const section = (id: string) => document.querySelector<HTMLElement>(`[data-library-id="${id}"]`)!;
const arrow = (id: string) => within(section(id)).getByRole("button", { name: new RegExp(`^(展开|收起)${names[id]}$`) });
const expanded = (id: string) => arrow(id).getAttribute("aria-expanded") === "true";
const inA = (local: BrowseScope): WorkspaceScope => ({ kind: "library", libraryId: "A", scope: local });
beforeEach(() => {
  pending = [];
  props.onScope.mockClear(); props.onError.mockClear();
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    throw new Error(command);
  });
});
afterEach(() => { vi.useRealTimers(); cleanup(); clearMocks(); });
async function loaded(view = render(<WorkspacePane {...props} />), value = forest()) {
  await settle();
  await act(async () => pending.at(-1)!.resolve(value));
  return view;
}

it("顶部“全部图片”带各库合计；每个图库一行：名称、张数，路径只在悬停提示里（方案 D）", async () => {
  await loaded();
  expect(screen.getByRole("button", { name: "全部图片（6 张）" })).toBeTruthy();
  const head = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  expect(head.title).toBe("D:\\A\\参考");
  expect(section("A").textContent).not.toContain("D:\\A\\参考");
  expect(section("A").textContent).not.toContain("文件夹");
  fireEvent.click(head);
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "all" } });
});

it("选中某库内的范围时只展开该库，选“全部图片”时全部折起；箭头可临时展开别的图库", async () => {
  const view = await loaded();
  expect([expanded("A"), expanded("B")]).toEqual([false, false]);
  expect(document.querySelectorAll("[data-folder-id]")).toHaveLength(0);
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "folderTree", id: "A-root" })} />);
  expect([expanded("A"), expanded("B")]).toEqual([true, false]);
  expect(within(section("A")).getByRole("button", { name: "未归类（1 张）" })).toBeTruthy();
  fireEvent.click(arrow("B"));
  expect([expanded("A"), expanded("B")]).toEqual([true, true]);
  // 同一库内换范围不收起临时展开的图库。
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "unassigned" })} />);
  expect([expanded("A"), expanded("B")]).toEqual([true, true]);
  view.rerender(<WorkspacePane {...props} scope={{ kind: "library", libraryId: "B", scope: { kind: "all" } }} />);
  expect([expanded("A"), expanded("B")]).toEqual([false, true]);
  view.rerender(<WorkspacePane {...props} scope={{ kind: "all" }} />);
  expect([expanded("A"), expanded("B")]).toEqual([false, false]);
  fireEvent.click(arrow("A"));
  expect([expanded("A"), expanded("B")]).toEqual([true, false]);
});

it("拖动图片悬停在折起的图库上约 0.6 秒自动展开，离开或放下后恢复折起", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    return [];
  });
  await loaded();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const data: Record<string, string> = { [DRAG_IMAGES]: JSON.stringify(["card-1"]), [DRAG_IMAGE_SOURCES]: JSON.stringify({ B: ["b-1"] }) };
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? "" };
  const head = within(section("B")).getByRole("button", { name: "风景参考（3 张）" });
  fireEvent.dragEnter(head, { dataTransfer });
  fireEvent.dragOver(head, { dataTransfer });
  act(() => { vi.advanceTimersByTime(590); });
  expect(expanded("B")).toBe(false);
  act(() => { vi.advanceTimersByTime(20); });
  expect(expanded("B")).toBe(true);
  fireEvent.dragLeave(section("B"), { dataTransfer });
  expect(expanded("B")).toBe(false);

  // 离开前没到时间：不展开。
  fireEvent.dragEnter(head, { dataTransfer });
  act(() => { vi.advanceTimersByTime(300); });
  fireEvent.dragLeave(section("B"), { dataTransfer });
  act(() => { vi.advanceTimersByTime(600); });
  expect(expanded("B")).toBe(false);

  fireEvent.dragEnter(head, { dataTransfer });
  act(() => { vi.advanceTimersByTime(600); });
  const folder = within(section("B")).getByRole("button", { name: "动作（1 张）" });
  fireEvent.dragOver(folder, { dataTransfer });
  fireEvent.drop(folder, { dataTransfer });
  expect(expanded("B")).toBe(false);
  vi.useRealTimers();
  await settle();
  expect(calls).toEqual([{ command: "plugin:library|edit", args: { libraryId: "B", ids: ["b-1"], edits: [{ kind: "addToFolder", folderId: "B-child" }] } }]);

  // 拖动在别处结束（取消）时也恢复。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.dragEnter(head, { dataTransfer });
  act(() => { vi.advanceTimersByTime(600); });
  expect(expanded("B")).toBe(true);
  fireEvent(window, new Event("dragend"));
  expect(expanded("B")).toBe(false);
});

it("已展开的图库不受拖动悬停影响，放下后保持展开", async () => {
  await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const dataTransfer = { types: [DRAG_IMAGES], getData: () => "[]" };
  fireEvent.dragEnter(within(section("A")).getByRole("button", { name: "人物参考（3 张）" }), { dataTransfer });
  act(() => { vi.advanceTimersByTime(600); });
  fireEvent.dragLeave(section("A"), { dataTransfer });
  fireEvent(window, new Event("drop"));
  expect(expanded("A")).toBe(true);
});

it("每个已连接图库的目录都可以直接整理，请求带上该图库的身份（ADR-0008，#112）", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    if (command === "plugin:library|create_folder") return "new-folder";
    return null;
  });
  await loaded();
  // 新建文件夹在图库标题的 ⋯ 里；折起的图库随之展开。
  fireEvent.click(within(section("A")).getByRole("button", { name: "人物参考 的操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "新建文件夹" }));
  expect(expanded("A")).toBe(true);
  const input = within(section("A")).getByRole("textbox", { name: "新文件夹名称" });
  fireEvent.change(input, { target: { value: "姿势" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await settle();
  expect(within(section("A")).getByRole("button", { name: "人物（2 张）" }).getAttribute("draggable")).toBe("true");
  fireEvent.doubleClick(within(section("A")).getByRole("button", { name: "动作（1 张）" }));
  const rename = within(section("A")).getByRole("textbox", { name: "文件夹名称" });
  fireEvent.change(rename, { target: { value: "跑跳" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  await settle();
  // 把子文件夹拖到图库标题上：移到顶层；另一个图库的文件夹不接受。
  const folder: Record<string, string> = { "application/x-kinshoko-folder": "A-child", "application/x-kinshoko-folder-library": "A" };
  const moving = { types: Object.keys(folder), getData: (type: string) => folder[type] ?? "" };
  const headA = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  fireEvent.dragOver(headA, { dataTransfer: moving });
  fireEvent.drop(headA, { dataTransfer: moving });
  fireEvent.drop(within(section("B")).getByRole("button", { name: "风景参考（3 张）" }), { dataTransfer: moving });
  await settle();
  expect(calls).toEqual([
    { command: "plugin:library|create_folder", args: { libraryId: "A", name: "姿势", parent: null } },
    { command: "plugin:library|rename_folder", args: { libraryId: "A", folderId: "A-child", name: "跑跳" } },
    { command: "plugin:library|move_folder", args: { libraryId: "A", folderId: "A-child", parent: null, position: 2 ** 31 } },
  ]);
  expect(props.onError).not.toHaveBeenCalled();
});

it("新建文件夹放在所选库当前打开的文件夹里", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    return "new";
  });
  await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "folderTree", id: "A-root" })} />));
  for (const id of ["A", "B"]) {
    fireEvent.click(within(section(id)).getByRole("button", { name: `${names[id]} 的操作` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "新建文件夹" }));
    const input = within(section(id)).getByRole("textbox", { name: "新文件夹名称" });
    fireEvent.change(input, { target: { value: "新" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
  }
  expect(calls.map((call) => call.args)).toEqual([
    { libraryId: "A", name: "新", parent: "A-root" },
    { libraryId: "B", name: "新", parent: null },
  ]);
});

it("每库为独立根展示完整目录，选择目录默认包含子文件夹，明确切换直接层级", async () => {
  const view = await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />));
  const a = section("A");
  expect(within(a).getByRole("button", { name: "人物（2 张）" })).toBeTruthy();
  fireEvent.click(within(a).getByRole("button", { name: "动作（1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "folderTree", id: "A-child" } });
  view.rerender(<WorkspacePane {...props} scope={inA({ kind: "folderTree", id: "A-root" })} />);
  const descendants = screen.getByRole("switch", { name: "含子文件夹" });
  expect(descendants.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(descendants);
  expect(within(a).getByRole("button", { name: "人物（1 张）" })).toBeTruthy();
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "folder", id: "A-root" } });
  fireEvent.click(arrow("B"));
  fireEvent.click(within(section("B")).getByRole("button", { name: "动作（1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "B", scope: { kind: "folder", id: "B-child" } });
});

it("把图拖进任一图库的文件夹，放入的是这张图在那个图库里的来源（#112）", async () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    if (command === "plugin:library|workspace_directories") return new Promise<WorkspaceDirectories>((resolve, reject) => pending.push({ safeMode: (args as { safeMode: boolean }).safeMode, resolve, reject }));
    calls.push({ command, args: args as Record<string, unknown> });
    return [];
  });
  await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />));
  const data: Record<string, string> = {
    [DRAG_IMAGES]: JSON.stringify(["card-1", "card-2"]),
    [DRAG_IMAGE_SOURCES]: JSON.stringify({ A: ["a-1"], B: ["b-1", "b-2"] }),
  };
  const dataTransfer = { types: Object.keys(data), getData: (type: string) => data[type] ?? "" };
  const folder = within(section("A")).getByRole("button", { name: "动作（1 张）" });
  fireEvent.dragOver(folder, { dataTransfer });
  fireEvent.drop(folder, { dataTransfer });
  await settle();
  expect(calls).toEqual([
    { command: "plugin:library|edit", args: { libraryId: "A", ids: ["a-1"], edits: [{ kind: "addToFolder", folderId: "A-child" }] } },
  ]);
});

it("目录响应迟到时不替换新代次，当前范围保持明确身份", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = render(<WorkspacePane {...props} scope={selected} />);
  await settle();
  view.rerender(<WorkspacePane {...props} scope={selected} safeMode={false} reloadKey={1} status={{ ...props.status, revision: "new" }} />);
  await settle();
  const fresh = forest("new");
  fresh.providers[0].sidebar!.folders[0].name = "新目录";
  await act(async () => pending[1].resolve(fresh));
  await act(async () => pending[0].resolve(forest("old")));
  const a = section("A");
  expect(within(a).queryByRole("button", { name: "人物（2 张）" })).toBeNull();
  expect(within(a).getByRole("button", { name: "新目录（2 张）" })).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
  expect(pending[1].safeMode).toBe(false);
});

it("断连库与失效文件夹保持原范围并禁用旧目录控件", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = await loaded(render(<WorkspacePane {...props} scope={selected} />));
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={1} />);
  const gone = forest("gone");
  gone.providers[0].sidebar!.folders = [];
  await act(async () => pending[1].resolve(gone));
  expect(screen.getByText("范围：人物参考 / 文件夹已失效")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "含子文件夹" }).hasAttribute("data-disabled")).toBe(true);
  view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={2} />);
  const missing = forest("missing");
  missing.providers[0].registration.unavailable = "未连接";
  missing.providers[0].sidebar = null;
  await act(async () => pending[2].resolve(missing));
  expect(within(section("A")).getByRole("button", { name: "人物参考（未连接）" })).toHaveProperty("disabled", true);
  expect(screen.getByText("范围：人物参考 / 未连接")).toBeTruthy();
  expect(props.onScope).not.toHaveBeenCalled();
});

it("读取时目录修订改变会自动重读，不留下要求用户操作的过期提示", async () => {
  render(<WorkspacePane {...props} scope={inA({ kind: "all" })} />);
  await settle();
  await act(async () => pending[0].reject("浏览结果已变化，请从头重新浏览"));
  await settle();
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(forest("fresh")));
  expect(document.querySelectorAll("[data-folder-id]")).toHaveLength(2);
  expect(props.onError).not.toHaveBeenCalled();
});

it("未连接的图库只占一行提示，名称变淡带警示点，可就地重新连接", async () => {
  const recheck = vi.fn();
  const missing = forest("offline");
  missing.providers[0].registration.unavailable = "资料库暂时不可用：移动盘没插";
  missing.providers[0].sidebar = null;
  await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "all" })} onRecheck={recheck} />), missing);
  const a = section("A");
  expect(a.getAttribute("data-offline")).toBe("true");
  expect(within(a).getByRole("button", { name: "人物参考（未连接）" })).toBeTruthy();
  expect(a.querySelector(".lib-dot.is-off")).toBeTruthy();
  const line = within(a).getByRole("status");
  expect(line.textContent).toBe("未连接 · 移动盘接回后可用 · 重新连接");
  expect(line.title).toContain("移动盘没插");
  expect(within(a).queryByRole("button", { name: /^(展开|收起)/ })).toBeNull();
  fireEvent.click(within(line).getByRole("button", { name: "重新连接" }));
  expect(recheck).toHaveBeenCalledTimes(1);
  expect(within(section("B")).queryByRole("button", { name: "重新连接" })).toBeNull();
});

it("回收站在侧栏底部跟随所选图库并显示库名", async () => {
  const two = forest(); two.providers[0].sidebar!.trash = 4; two.providers[1].sidebar!.trash = 2;
  const view = await loaded(render(<WorkspacePane {...props} scope={inA({ kind: "folderTree", id: "A-root" })} />), two);
  const trash = screen.getAllByRole("button", { name: /^回收站/ });
  expect(trash).toHaveLength(1);
  expect(trash[0].closest(".side-foot")).toBeTruthy();
  expect(trash[0].getAttribute("aria-label")).toBe("回收站 · 人物参考（4 张）");
  fireEvent.click(trash[0]);
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "trash" } });
  view.rerender(<WorkspacePane {...props} scope={{ kind: "library", libraryId: "B", scope: { kind: "trash" } }} />);
  const shown = screen.getByRole("button", { name: /^回收站/ });
  expect(shown.getAttribute("aria-label")).toBe("回收站 · 风景参考（2 张）");
  expect(shown.getAttribute("aria-current")).toBe("page");
});

it("选“全部图片”时回收站显示各库合计，点开按库分组列出", async () => {
  const two = forest(); two.providers[0].sidebar!.trash = 4; two.providers[1].sidebar!.trash = 2;
  await loaded(undefined, two);
  const total = screen.getByRole("button", { name: "回收站 · 全部图库（6 张）" });
  expect(total.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(total);
  expect(total.getAttribute("aria-expanded")).toBe("true");
  const list = screen.getByRole("group", { name: "各图库的回收站" });
  expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["人物参考（4 张）", "风景参考（2 张）"]);
  fireEvent.click(within(list).getByRole("button", { name: "风景参考（2 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "B", scope: { kind: "trash" } });
});

it("只有一个已连接图库时，“全部图片”下的回收站直接打开它", async () => {
  const one = forest(); one.providers[0].sidebar!.trash = 1;
  one.providers[1].registration.unavailable = "未连接"; one.providers[1].sidebar = null;
  await loaded(undefined, one);
  fireEvent.click(screen.getByRole("button", { name: "回收站 · 全部图库（1 张）" }));
  expect(props.onScope).toHaveBeenLastCalledWith({ kind: "library", libraryId: "A", scope: { kind: "trash" } });
});

it("导入期间列表过期只重读目录：资料库行与展开的文件夹沿用同一批 DOM 节点，只更新张数（#121）", async () => {
  const selected = inA({ kind: "folderTree", id: "A-root" });
  const view = await loaded(render(<WorkspacePane {...props} scope={selected} />));
  const head = within(section("A")).getByRole("button", { name: "人物参考（3 张）" });
  const chevron = arrow("A");
  const folder = within(section("A")).getByRole("button", { name: "人物（2 张）" });
  // 导入进度推进时，每次列表过期 App 都给 reloadKey 加一；目录响应到达前与到达后都不换节点。
  for (let reload = 1; reload <= 3; reload++) {
    view.rerender(<WorkspacePane {...props} scope={selected} reloadKey={reload} />);
    await settle();
    expect(section("A").contains(head)).toBe(true);
    expect(head).toHaveProperty("disabled", false);
    expect(section("A").contains(chevron) && section("A").contains(folder)).toBe(true);
    const next = forest();
    next.providers[0].sidebar!.all = 3 + reload;
    await act(async () => pending.at(-1)!.resolve(next));
    expect(head.getAttribute("aria-label")).toBe(`人物参考（${3 + reload} 张）`);
    expect(section("A").contains(chevron) && section("A").contains(folder)).toBe(true);
  }
  expect(props.onError).not.toHaveBeenCalled();
});
