import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { App } from "./App";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  mockConvertFileSrc("windows");mockWindows("main");
});
afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); vi.unstubAllGlobals(); });

it("保存为关闭安全模式且活动库断连时，仍显示可用提供方的现有工作区", async () => {
  const libraries = [
    { library: { id: "A", name: "可用甲库", root: "A" }, unavailable: null },
    { library: { id: "B", name: "断连乙库", root: "B" }, unavailable: "移动盘未连接" },
  ];
  mockIPC((command, args) => {
    if (command === "plugin:library|safe_mode") return false;
    if (command === "plugin:library|current_library") return Promise.reject("移动盘未连接");
    if (command === "plugin:library|registered_libraries") return libraries;
    if (command === "plugin:library|workspace_status") {
      if ((args as { safeMode: boolean }).safeMode) return Promise.reject("安全模式刚切换过，请重新查找");
      return { revision: "unsafe", libraries };
    }
    if (command === "plugin:library|workspace_directories") return {status:{revision:"unsafe",libraries},providers:libraries.map(registration=>({registration,sidebar:registration.unavailable?null:{all:1,trash:0,folders:[]},unassigned:1,descendants:{}}))};
    if (command === "plugin:library|import_tasks") return [];
    if (command === "plugin:library|workspace_browse") return {
      cards: [{ id: "bytes", libraryId: "A", imageId: "a", width: 100, height: 100, thumbnail: "A/a/128", adult: false,
        sources: [{ libraryId: "A", libraryName: "可用甲库", imageId: "a", unavailable: null, matches: true, deleted: false }] }],
      total: 1, nextCursor: null, status: { revision: "unsafe", libraries },
    };
    if (command === "app_info") return { productName: "Kinshoko", version: "1" };
    return null;
  }, { shouldMockEvents: true });
  render(<App />);
  expect(await screen.findByRole("img", { name: "参考图" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "全部资料库" })).toBeTruthy();
  expect(screen.getByText("移动盘未连接", { selector: ".provider-problem" })).toBeTruthy();
});
