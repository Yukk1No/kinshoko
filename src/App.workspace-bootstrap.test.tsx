import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { App } from "./App";
import { appStartup } from "./App.fixtures";
import { fakeBackend } from "./test/backend";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  mockConvertFileSrc("windows");
});
afterEach(() => { vi.unstubAllGlobals(); });

it("保存为关闭安全模式且活动库断连时，仍显示可用提供方的现有工作区", async () => {
  const libraries = [
    { library: { id: "A", name: "可用甲库", root: "A" }, unavailable: null },
    { library: { id: "B", name: "断连乙库", root: "B" }, unavailable: { code: "system" as const, detail: "移动盘未连接" } },
  ];
  fakeBackend({
    safe_mode: false,
    current_library: () => Promise.reject("移动盘未连接"),
    registered_libraries: libraries,
    workspace_status: (args) => {
      if (args.safeMode) return Promise.reject({ code: "lensChanged" });
      return { revision: "unsafe", libraries };
    },
    workspace_directories: { status: { revision: "unsafe", libraries }, registrationOrder: [], providers: libraries.map((registration) => ({ registration, sidebar: registration.unavailable ? null : { all: 1, trash: 0, folders: [] }, unassigned: 1, descendants: {} })) },
    import_tasks: [],
    workspace_browse: {
      cards: [{ id: "bytes", libraryId: "A", imageId: "a", width: 100, height: 100, thumbnail: "A/a/128", adult: false,
        sources: [{ libraryId: "A", libraryName: "可用甲库", imageId: "a", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: { revision: "unsafe", libraries },
    },
    app_info: { productName: "Kinshoko", version: "1" },
    // 启动时取走留给主窗口的收集请求：没有。
    ...appStartup,
  });
  render(<App />);
  expect(await screen.findByRole("img", { name: "参考图" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^全部图片/ })).toBeTruthy();
  // 未连接的图库只占一行（方案 D，#113）：同一行末尾“重新连接”，原因在悬停提示里（设计系统 v2）。
  const retry = await screen.findByRole("button", { name: "重新连接" });
  fireEvent.focus(retry.closest(".lib-head")!);
  expect(await screen.findByText(/移动盘未连接/, { selector: ".k-tip" })).toBeTruthy();
});
