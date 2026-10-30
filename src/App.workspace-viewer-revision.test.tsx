// #98: the real App and Wall must agree which public workspace snapshot authorized a card.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import type { WorkspacePage } from "./bindings/WorkspacePage";

/** 浏览器里的双击：两次按下与单击，再一次 dblclick。双击按第一下的图判定（#179）。 */
function doubleClick(target: Element) {
  for (const detail of [1, 2]) {
    fireEvent.pointerDown(target, { button: 0 });
    fireEvent.click(target, { detail });
  }
  fireEvent.doubleClick(target, { detail: 2 });
}

const libraries = [{ library: { id: "A", name: "甲库", root: "A" }, unavailable: null }];
const status = (revision: string) => ({ revision, libraries });
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows"); mockWindows("main");
});
afterEach(async () => { cleanup(); await new Promise(done => setTimeout(done, 0)); clearMocks(); vi.unstubAllGlobals(); });

function workspace(initialReply?: Promise<WorkspaceStatus>) {
  const state = { initialRevision: "r1", wallRevision: "r2", available: true, safe: false, deleted: false, imageId: "a", contentId: "bytes", inTwoLibraries: false,
    nextBrowse: null as (() => Promise<WorkspacePage>) | null, browseReply: null as Promise<WorkspacePage> | null,
    calls: [] as { command: string; args: unknown }[] };
  mockIPC((command, args) => {
    state.calls.push({ command, args });
    if (command === "plugin:library|safe_mode") return state.safe;
    if (command === "plugin:library|current_library") return libraries[0].library;
    if (command === "plugin:library|registered_libraries") return libraries;
    if (command === "plugin:library|workspace_status") return initialReply ?? status(state.initialRevision);
    if (command === "plugin:library|workspace_directories") return { status: status(state.wallRevision), providers: [{ registration: libraries[0], sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 1, descendants: {} }] };
    if (command === "plugin:library|workspace_tag_groups" || command === "plugin:library|import_tasks") return [];
    if (command === "tagging_status") return { libraryId: "A", status: { state: "starting" } };
    if (command === "plugin:library|workspace_browse") {
      if (state.nextBrowse) { const next = state.nextBrowse; state.nextBrowse = null; return next(); }
      if (state.browseReply) return state.browseReply;
      return {
        cards: state.available ? [{ id: state.contentId, libraryId: "A", imageId: state.imageId, width: 100, height: 100, adult: false,
          sources: [{ libraryId: "A", libraryName: "甲库", imageId: state.imageId, unavailable: null, matches: true, deleted: state.deleted },
            // 来源按钮只在两个及以上图库时出现（#221）：需要按钮的用例再挂一份离线来源。
            ...(state.inTwoLibraries ? [{ libraryId: "B", libraryName: "乙库", imageId: "b", unavailable: "离线", matches: false, deleted: false }] : [])] }] : [],
        total: state.available ? 1 : 0, nextCursor: null, status: status(state.wallRevision),
      };
    }
    if (command === "plugin:library|workspace_image") {
      if (!state.available) return Promise.reject({ code: "unknownImage" });
      return { id: (args as { imageId: string }).imageId, originalName: "参考图", width: 100, height: 100, collectedAt: 1000, sourceLinks: [],
        folders: [], note: { manual: null, sources: [] }, deletedAt: null, versions: { previous: null, newer: [] },
        rating: { imageId: "a", suggested: null, manual: null, effective: null } };
    }
    if (command === "plugin:library|workspace_source_inspection") {
      if (!state.available) return Promise.reject("此来源已封印");
      return { detail: { id: state.imageId, originalName: "参考图", width: 100, height: 100, collectedAt: 1000, sourceLinks: [],
        folders: [], note: { manual: "来源备注", sources: [] }, deletedAt: null, versions: { previous: null, newer: [] },
        rating: { imageId: state.imageId, suggested: null, manual: null, effective: null } },
        tags: { image: { tags: [], rejected: [] }, identities: [] }, sidebar: { all: 1, trash: 0, folders: [] } };
    }
    if (command === "plugin:desktop|reference_groups") return [];
    if (command === "plugin:library|catalog_image_tags") return { image: { imageId: state.imageId, tags: [], rejected: [] }, identities: [] };
    if (command === "plugin:library|workspace_sidebar" || command === "plugin:library|sidebar") return { all: state.available ? 1 : 0, trash: 0, folders: [] };
    if (command === "shell_settings") return { autostart: false, shortcuts: [], showApproxSource: false, viewerBackground: "mid" };
    if (command === "app_info") return { productName: "Kinshoko", version: "1" };
    if (command === "plugin:library|workspace_edit_sources") return [];
    return null;
  }, { shouldMockEvents: true });
  return state;
}

async function open() {
  render(<App />);
  const image = await screen.findByRole("img", { name: "参考图" });
  doubleClick(image.closest<HTMLElement>('[role="option"]')!);
  const viewer = await screen.findByRole("region", { name: "原图查看器" });
  await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/a/full"));
  return viewer;
}

it("新工作区快照上的图片已双击打开，迟到的同一修订通知不能关闭查看器", async () => {
  workspace();
  const viewer = await open();
  await act(() => emit("workspace-changed", status("r2")));
  expect(screen.getByRole("region", { name: "原图查看器" })).toBe(viewer);
  expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/a/full");
});

it("真正的新修订撤销正在查看的旧图片，重读后不再显示已失效的内容", async () => {
  const state = workspace();
  await open();
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", available: false });
  await act(() => emit("workspace-changed", status("r3")));
  expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull();
  await waitFor(() => expect(screen.getByRole("listbox", { name: "图片墙" }).dataset.total).toBe("0"));
  expect(screen.queryByRole("img", { name: "参考图" })).toBeNull();
});

it("先发的旧状态读取迟到，不能回滚图片墙已接受的新快照并让同修订通知关闭查看器", async () => {
  let resolveInitial!: (value: WorkspaceStatus) => void;
  const initialReply = new Promise<WorkspaceStatus>(resolve => { resolveInitial = resolve; });
  workspace(initialReply);
  const viewer = await open();
  await act(async () => { resolveInitial(status("r1")); });
  await act(() => emit("workspace-changed", status("r2")));
  expect(screen.getByRole("region", { name: "原图查看器" })).toBe(viewer);
});

it("旧浏览响应与较新通知同批到达，也不能放回旧图片或回滚查看器的授权修订", async () => {
  const state = workspace();
  const viewer = await open();
  fireEvent.keyDown(viewer, { key: "Escape" });
  let resolveOld!: (value: WorkspacePage) => void, started!: () => void;
  const oldPage = new Promise<WorkspacePage>(resolve => { resolveOld = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  state.nextBrowse = () => { started(); return oldPage; };
  fireEvent.click(screen.getByRole("button", { name: "甲库（1 张）" }));
  await requestStarted;
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", contentId: "new-bytes", imageId: "new" });
  await act(async () => {
    await emit("workspace-changed", status("r3"));
    resolveOld({ cards: [{ id: "old-bytes", libraryId: "A", imageId: "old", width: 100, height: 100, adult: false,
      sources: [{ libraryId: "A", libraryName: "甲库", imageId: "old", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: status("r2") });
  });
  await waitFor(() => expect(screen.getByRole("img", { name: "参考图" }).getAttribute("src")).toBe("http://thumb.localhost/A/new/384"));
  doubleClick(screen.getByRole("img", { name: "参考图" }).closest<HTMLElement>('[role="option"]')!);
  const currentViewer = await screen.findByRole("region", { name: "原图查看器" });
  await waitFor(() => expect(currentViewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/new/full"));
  await act(() => emit("workspace-changed", status("r3")));
  expect(screen.getByRole("region", { name: "原图查看器" })).toBe(currentViewer);
});

it("后台已知副本分级使聚合图封印时，保留来源详情面板，面板里不出现图片像素", async () => {
  const state = workspace();
  state.safe = true;
  state.inTwoLibraries = true;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "在 2 个图库，查看详情" }));
  const inspector = screen.getByLabelText("详情", { selector: "aside" });
  // 详情面板没有缩略图（#179）。
  expect(within(inspector).queryByRole("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "整理此来源" }));
  await screen.findByRole("textbox", { name: "备注" });
  // Background tagging revokes the aggregate through the public provider snapshot; no manual onClear action.
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", available: false });
  await act(() => emit("workspace-changed", status("r3")));
  await waitFor(() => expect(screen.getByRole("listbox", { name: "图片墙" }).dataset.total).toBe("0"));
  expect(screen.getByLabelText("详情", { selector: "aside" })).toBe(inspector);
  expect(within(inspector).queryByRole("img")).toBeNull();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "此来源已封印");
});

it("首个修订通知先于初始状态和浏览响应到达时，图片墙重读当前修订", async () => {
  let resolveInitial!: (value: WorkspaceStatus) => void;
  const initialReply = new Promise<WorkspaceStatus>(resolve => { resolveInitial = resolve; });
  const state = workspace(initialReply);
  let resolveOld!: (value: WorkspacePage) => void, started = false;
  const oldPage = new Promise<WorkspacePage>(resolve => { resolveOld = resolve; });
  // Hold every initial page, including an initial safety recheck, until the notification arrives.
  state.nextBrowse = () => { started = true; state.browseReply = oldPage; return oldPage; };
  render(<App />);
  await waitFor(() => expect(started).toBe(true));
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", contentId: "new-bytes", imageId: "new", browseReply: null });
  await act(async () => {
    await emit("workspace-changed", status("r3"));
    resolveInitial(status("r1"));
    resolveOld({ cards: [{ id: "old-bytes", libraryId: "A", imageId: "old", width: 100, height: 100,
      adult: false,
      sources: [{ libraryId: "A", libraryName: "甲库", imageId: "old", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: status("r1") });
  });
  const image = await screen.findByRole("img", { name: "参考图" });
  expect(image.getAttribute("src")).toBe("http://thumb.localhost/A/new/384");
  doubleClick(image.closest<HTMLElement>('[role="option"]')!);
  const viewer = await screen.findByRole("region", { name: "原图查看器" });
  await act(() => emit("workspace-changed", status("r3")));
  expect(screen.getByRole("region", { name: "原图查看器" })).toBe(viewer);
});

it.each(["explicit", "selected"])("列表失效时 %s 详情面板保留，重读等待或失败时面板里也没有图片像素", async (entry) => {
  const state = workspace();
  state.safe = true;
  state.inTwoLibraries = entry === "explicit";
  render(<App />);
  if (entry === "explicit") {
    fireEvent.click(await screen.findByRole("button", { name: "在 2 个图库，查看详情" }));
  } else {
    const image = await screen.findByRole("img", { name: "参考图" });
    // 只在一个图库的图没有来源按钮（#221），选中它照样进详情。
    expect(document.querySelector(".card-sources")).toBeNull();
    fireEvent.click(image.closest<HTMLElement>('[role="option"]')!, { ctrlKey: true });
  }
  const inspector = screen.getByLabelText("详情", { selector: "aside" });
  let rejectBrowse!: (reason: string) => void, started = false;
  const pending = new Promise<WorkspacePage>((_, reject) => { rejectBrowse = reject; });
  state.nextBrowse = () => { started = true; return pending; };
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", available: false });
  try {
    await act(() => emit("library-event", { kind: "listStale", libraryId: "A" }));
    await waitFor(() => expect(started).toBe(true));
    expect(screen.getByLabelText("详情", { selector: "aside" })).toBe(inspector);
    expect(within(inspector).queryByRole("img")).toBeNull();
    await act(async () => { rejectBrowse("资料库暂不可读"); });
    await screen.findByText("资料库暂不可读");
    expect(screen.getByLabelText("详情", { selector: "aside" })).toBe(inspector);
    expect(within(inspector).queryByRole("img")).toBeNull();
  } finally {
    await act(async () => { rejectBrowse("资料库暂不可读"); });
  }
});

it("查看器右键“移到回收站”把正在看的这份来源移进回收站并回到图片墙（#114）", async () => {
  const state = workspace();
  const viewer = await open();
  fireEvent.contextMenu(viewer.querySelector<HTMLElement>(".viewer-stage")!, { clientX: 50, clientY: 50 });
  const menu = await screen.findByRole("menu", { name: "查看器菜单" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "移到回收站" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "原图查看器" })).toBeNull());
  await waitFor(() => expect(state.calls.filter((c) => c.command === "plugin:library|workspace_edit_sources").map((c) => c.args)).toEqual([
    { targets: [{ libraryId: "A", imageId: "a", contentId: "bytes" }], safeMode: false, edits: [{ kind: "delete" }] },
  ]));
});

it("查看器是否给“移到回收站”看正在看的这份来源，不看背后图片墙的范围：已在回收站的来源不再给", async () => {
  const state = workspace();
  state.deleted = true;
  const viewer = await open();
  fireEvent.contextMenu(viewer.querySelector<HTMLElement>(".viewer-stage")!, { clientX: 50, clientY: 50 });
  const menu = await screen.findByRole("menu", { name: "查看器菜单" });
  expect(within(menu).queryByRole("menuitem", { name: "移到回收站" })).toBeNull();
});
