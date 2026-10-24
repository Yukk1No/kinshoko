import { expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { WorkspacePane } from "./WorkspacePane";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES } from "../wall/Wall";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import { names, pending, props, settle, section, arrow, expanded, inA, loaded } from "./WorkspacePane.fixtures";

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

