// #98: the real App and Wall must agree which public workspace snapshot authorized a card.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import type { WorkspaceStatus } from "./bindings/WorkspaceStatus";
import type { WorkspacePage } from "./bindings/WorkspacePage";

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
  const state = { initialRevision: "r1", wallRevision: "r2", available: true, safe: false, imageId: "a", contentId: "bytes",
    nextBrowse: null as (() => Promise<WorkspacePage>) | null };
  mockIPC((command, args) => {
    if (command === "plugin:library|safe_mode") return state.safe;
    if (command === "plugin:library|current_library") return libraries[0].library;
    if (command === "plugin:library|registered_libraries") return libraries;
    if (command === "plugin:library|workspace_status") return initialReply ?? status(state.initialRevision);
    if (command === "plugin:library|workspace_directories") return { status: status(state.wallRevision), providers: [{ registration: libraries[0], sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 1, descendants: {} }] };
    if (command === "plugin:library|workspace_tag_groups" || command === "plugin:library|import_tasks") return [];
    if (command === "tagging_status") return { libraryId: "A", status: { state: "starting" } };
    if (command === "plugin:library|workspace_browse") {
      if (state.nextBrowse) { const next = state.nextBrowse; state.nextBrowse = null; return next(); }
      return {
        cards: state.available ? [{ id: state.contentId, libraryId: "A", imageId: state.imageId, width: 100, height: 100, thumbnail: `A/${state.imageId}/128`, adult: false,
          sources: [{ libraryId: "A", libraryName: "甲库", imageId: state.imageId, unavailable: null, matches: true, deleted: false }] }] : [],
        total: state.available ? 1 : 0, nextCursor: null, status: status(state.wallRevision),
      };
    }
    if (command === "plugin:library|workspace_image") {
      if (!state.available) return Promise.reject("资料库中没有这张参考图");
      return { id: (args as { imageId: string }).imageId, originalName: "参考图", width: 100, height: 100, collectedAt: 1000, sourceLinks: [],
        folders: [], note: { manual: null, sources: [] }, deletedAt: null, versions: { previous: null, newer: [] },
        rating: { imageId: "a", suggested: null, manual: null, effective: null } };
    }
    if (command === "shell_settings") return { autostart: false, shortcuts: [], showApproxSource: false, viewerBackground: "mid" };
    if (command === "app_info") return { productName: "Kinshoko", version: "1" };
    return null;
  }, { shouldMockEvents: true });
  return state;
}

async function open() {
  render(<App />);
  const image = await screen.findByRole("img", { name: "参考图" });
  fireEvent.click(image.closest<HTMLElement>('[role="option"]')!);
  const viewer = await screen.findByRole("dialog", { name: "原图查看器" });
  await waitFor(() => expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/a/full"));
  return viewer;
}

it("新工作区快照上的图片已单击打开，迟到的同一修订通知不能关闭查看器", async () => {
  workspace();
  const viewer = await open();
  await act(() => emit("workspace-changed", status("r2")));
  expect(screen.getByRole("dialog", { name: "原图查看器" })).toBe(viewer);
  expect(viewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/a/full");
});

it("真正的新修订撤销正在查看的旧图片，重读后不再显示已失效的内容", async () => {
  const state = workspace();
  await open();
  Object.assign(state, { initialRevision: "r3", wallRevision: "r3", available: false });
  await act(() => emit("workspace-changed", status("r3")));
  expect(screen.queryByRole("dialog", { name: "原图查看器" })).toBeNull();
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
  expect(screen.getByRole("dialog", { name: "原图查看器" })).toBe(viewer);
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
    resolveOld({ cards: [{ id: "old-bytes", libraryId: "A", imageId: "old", width: 100, height: 100, thumbnail: "A/old/128", adult: false,
      sources: [{ libraryId: "A", libraryName: "甲库", imageId: "old", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: status("r2") });
  });
  await waitFor(() => expect(screen.getByRole("img", { name: "参考图" }).getAttribute("src")).toBe("http://thumb.localhost/A/new/128"));
  fireEvent.click(screen.getByRole("img", { name: "参考图" }).closest<HTMLElement>('[role="option"]')!);
  const currentViewer = await screen.findByRole("dialog", { name: "原图查看器" });
  await waitFor(() => expect(currentViewer.querySelector("img")?.getAttribute("src")).toBe("http://thumb.localhost/A/new/full"));
  await act(() => emit("workspace-changed", status("r3")));
  expect(screen.getByRole("dialog", { name: "原图查看器" })).toBe(currentViewer);
});
