// #98: a workspace read whose revision moved underneath it is a re-read signal, not a standing problem.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "./App";
import { fakeBackend, type Args } from "./test/backend";

const EXPIRED: unknown = { code: "cursorExpired" };
/** 修订变化在中文界面上的说明；不应留在界面上。 */
const EXPIRED_TEXT = "浏览结果已变化，请从头重新浏览";
const libraries = [{ library: { id: "A", name: "甲库", root: "A" }, unavailable: null }];

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
});
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * The formal workspace IPC at revision `revision`. Once `failing` is set, the next `failures`
 * calls of that command are rejected the way the library rejects a read whose revision moved.
 */
function workspace() {
  const state = { revision: "r1", failing: null as string | null, failures: 0, calls: 0, failure: EXPIRED as unknown };
  const status = () => ({ revision: state.revision, libraries });
  const replies: Record<string, () => unknown> = {
    safe_mode: () => false,
    current_library: () => libraries[0].library,
    registered_libraries: () => libraries,
    workspace_status: status,
    workspace_directories: () => ({ status: status(), registrationOrder: [], providers: [{ registration: libraries[0], sidebar: { all: 1, trash: 0, folders: [] }, unassigned: 1, descendants: {} }] }),
    workspace_tag_groups: () => [{ id: "g", name: "人物分组", namespace: null, tags: [] }],
    import_tasks: () => [],
    tagging_status: () => ({ state: "starting" }),
    workspace_browse: () => ({
      cards: [{ id: "bytes", libraryId: "A", imageId: "a", width: 100, height: 100, thumbnail: "A/a/128", adult: false,
        sources: [{ libraryId: "A", libraryName: "甲库", imageId: "a", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: status(),
    }),
    app_info: () => ({ productName: "Kinshoko", version: "1" }),
    // 启动时取走留给主窗口的收集请求：没有。
    take_collection_request: () => null,
  };
  /** 设了 `failing` 的那条命令，接下来 `failures` 次按资料库拒绝修订已变的读取那样被拒绝。 */
  const failable = (command: string, reply: () => unknown) => (_: Args) => {
    if (command === state.failing) {
      state.calls += 1;
      if (state.calls <= state.failures) return Promise.reject(state.failure);
    }
    return reply();
  };
  fakeBackend(Object.fromEntries(Object.entries(replies).map(([command, reply]) => [command, failable(command, reply)])));
  return state;
}

async function settled() {
  render(<App />);
  await screen.findByRole("img", { name: "参考图" });
  await screen.findByRole("button", { name: /人物分组/ });
  await screen.findByRole("button", { name: "甲库（1 张）" });
}

/** A library change lands (copy, import…): the workspace moves to r2 and re-reads. */
async function changed(state: ReturnType<typeof workspace>, command: string, failures: number, failure: unknown = EXPIRED) {
  Object.assign(state, { failing: command, failures, calls: 0, failure, revision: "r2" });
  await act(() => emit("workspace-changed", { revision: "r2", libraries }));
}

it("变更后标签分组读取期间修订又变了：重新读取并显示分组，不留下“浏览结果已变化”横幅", async () => {
  const state = workspace();
  await settled();
  await changed(state, "workspace_tag_groups", 1);
  await waitFor(() => expect(state.calls).toBeGreaterThan(state.failures));
  expect(await screen.findByRole("button", { name: /人物分组/ })).toBeTruthy();
  expect(screen.queryAllByText(EXPIRED_TEXT)).toHaveLength(0);
});

it("连续变更期间目录读取多次遇到修订变化：变更停下后显示目录，不留下横幅或提示", async () => {
  const state = workspace();
  await settled();
  // More consecutive expiries than one pane retries on its own (a burst of imports or copies).
  await changed(state, "workspace_directories", 8);
  await waitFor(() => expect(state.calls).toBeGreaterThan(state.failures));
  expect(await screen.findByRole("button", { name: "甲库（1 张）" })).toBeTruthy();
  await waitFor(() => expect(screen.queryAllByText(EXPIRED_TEXT)).toHaveLength(0));
  expect(screen.queryByText("正在读取图库…")).toBeNull();
});

it("真正的读取失败仍以提示报告，一直留到用户确认", async () => {
  const state = workspace();
  await settled();
  await changed(state, "workspace_tag_groups", 1, { code: "message", message: "资料库文件无法读取" });
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain("资料库文件无法读取");
  // 错误提示急切播报（隐藏的 alert），可见的提示卡在获得焦点前不重复朗读，所以按钮查找要包括它。
  await act(async () => screen.getByRole("button", { name: "知道了", hidden: true }).click());
  await waitFor(() => expect(screen.queryByText("资料库文件无法读取")).toBeNull());
});
