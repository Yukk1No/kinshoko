// #98: a workspace read whose revision moved underneath it is a re-read signal, not a standing problem.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";

const EXPIRED = "浏览结果已变化，请从头重新浏览";
const libraries = [{ library: { id: "A", name: "甲库", root: "A" }, unavailable: null }];

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows"); mockWindows("main");
});
afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); vi.unstubAllGlobals(); });

/**
 * The formal workspace IPC at revision `revision`. Once `failing` is set, the next `failures`
 * calls of that command are rejected the way the library rejects a read whose revision moved.
 */
function workspace() {
  const state = { revision: "r1", failing: null as string | null, failures: 0, calls: 0, failure: EXPIRED };
  mockIPC((command, args) => {
    if (command === state.failing) {
      state.calls += 1;
      if (state.calls <= state.failures) return Promise.reject(state.failure);
    }
    const status = { revision: state.revision, libraries };
    if (command === "plugin:library|safe_mode") return false;
    if (command === "plugin:library|current_library") return libraries[0].library;
    if (command === "plugin:library|registered_libraries") return libraries;
    if (command === "plugin:library|workspace_status") return status;
    if (command === "plugin:library|workspace_directories") return { status, providers: [{ registration: libraries[0], sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 1, descendants: {} }] };
    if (command === "plugin:library|workspace_tag_groups") return [{ id: "g", name: "人物分组", namespace: null, tags: [] }];
    if (command === "plugin:library|import_tasks") return [];
    if (command === "tagging_status") return { libraryId: (args as { libraryId: string }).libraryId, status: { state: "starting" } };
    if (command === "plugin:library|workspace_browse") return {
      cards: [{ id: "bytes", libraryId: "A", imageId: "a", width: 100, height: 100, thumbnail: "A/a/128", adult: false,
        sources: [{ libraryId: "A", libraryName: "甲库", imageId: "a", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status,
    };
    if (command === "app_info") return { productName: "Kinshoko", version: "1" };
    return null;
  }, { shouldMockEvents: true });
  return state;
}

async function settled() {
  render(<App />);
  await screen.findByRole("img", { name: "参考图" });
  await screen.findByRole("button", { name: /人物分组/ });
  await screen.findByRole("button", { name: "甲库（1 张）" });
}

/** A library change lands (copy, import…): the workspace moves to r2 and re-reads. */
async function changed(state: ReturnType<typeof workspace>, command: string, failures: number, failure = EXPIRED) {
  Object.assign(state, { failing: `plugin:library|${command}`, failures, calls: 0, failure, revision: "r2" });
  await act(() => emit("workspace-changed", { revision: "r2", libraries }));
}

it("变更后标签分组读取期间修订又变了：重新读取并显示分组，不留下“浏览结果已变化”横幅", async () => {
  const state = workspace();
  await settled();
  await changed(state, "workspace_tag_groups", 1);
  await waitFor(() => expect(state.calls).toBeGreaterThan(state.failures));
  expect(await screen.findByRole("button", { name: /人物分组/ })).toBeTruthy();
  expect(screen.queryAllByText(EXPIRED)).toHaveLength(0);
});

it("连续变更期间目录读取多次遇到修订变化：变更停下后显示目录，不留下横幅或提示", async () => {
  const state = workspace();
  await settled();
  // More consecutive expiries than one pane retries on its own (a burst of imports or copies).
  await changed(state, "workspace_directories", 8);
  await waitFor(() => expect(state.calls).toBeGreaterThan(state.failures));
  expect(await screen.findByRole("button", { name: "甲库（1 张）" })).toBeTruthy();
  await waitFor(() => expect(screen.queryAllByText(EXPIRED)).toHaveLength(0));
  expect(screen.queryByText("正在读取保存位置…")).toBeNull();
});

it("真正的读取失败仍显示横幅，直到用户确认", async () => {
  const state = workspace();
  await settled();
  await changed(state, "workspace_tag_groups", 1, "资料库文件无法读取");
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain("资料库文件无法读取");
  await act(async () => screen.getByRole("button", { name: "知道了" }).click());
  expect(screen.queryByText("资料库文件无法读取")).toBeNull();
});
