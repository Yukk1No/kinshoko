import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { list, NOW, recent, status } from "./subscriptions.fixtures";

// 安全模式范围收紧时先遮住已载入的图（开关不变），与截图时登记订阅页的缩略图（#368）。
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
// 窗口按钮的监听走 Tauri 自己的事件插件，这里用不着。
vi.mock("../ui/WinCtrls", () => ({ WinCtrls: () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => { events.set(name, callback); return () => events.delete(name); }) }));

let reads: { resolve: (images: ReceivedImage[]) => void; reject: (e: unknown) => void }[] = [];
const reports: any[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  localStorage.setItem("kinshoko.subscriptions.firstRunSeen", "1");
  reads = [];
  reports.length = 0;
  mockWindows("main");
  mockConvertFileSrc("windows");
  mockIPC((cmd, args) => {
    if (cmd === "subscriptions") return list;
    if (cmd === "subscription_recent") return new Promise((resolve, reject) => reads.push({ resolve, reject }));
    if (cmd === "plugin:desktop|report_capture_references") reports.push(args);
    return null;
  }, { shouldMockEvents: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); clearMocks(); events.clear(); });

const tiles = () => screen.queryAllByRole("button", { name: "在图库中打开" });
const page = () => render(<SubscriptionsPage status={status()} onStatus={vi.fn()} safe paneOpen onPaneToggle={vi.fn()} onOpenImage={vi.fn()} />);

it("安全模式开着时收紧范围：按新范围重读之前一张都不显示，重读失败也不显示", async () => {
  page();
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].resolve(recent));
  expect(tiles()).toHaveLength(3);
  await waitFor(() => expect(events.has("safe-mode-setting")).toBe(true));
  // 范围改了：开关仍开着。
  act(() => events.get("safe-mode-setting")!({ payload: true }));
  expect(tiles()).toHaveLength(0);
  await waitFor(() => expect(reads).toHaveLength(2));
  await act(async () => reads[1].reject({ code: "system", detail: "x" }));
  expect(tiles()).toHaveLength(0);
  act(() => events.get("safe-mode-setting")!({ payload: true }));
  await waitFor(() => expect(reads).toHaveLength(3));
  await act(async () => reads[2].resolve(recent.slice(0, 1)));
  expect(tiles()).toHaveLength(1);
});

it("截图时登记看得见的缩略图，钉出来的是图库里那张图", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.matches("img") ? new DOMRect(100, 120, 200, 300) : new DOMRect(0, 0, 1000, 800);
  });
  page();
  await waitFor(() => expect(reads).toHaveLength(1));
  await act(async () => reads[0].resolve(recent.slice(0, 1)));
  const img = tiles()[0].querySelector("img")!;
  Object.defineProperties(img, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 384 }, naturalHeight: { configurable: true, value: 576 } });
  fireEvent.load(img);
  await waitFor(() => expect(events.has("capture-reference-request")).toBe(true));
  await act(async () => events.get("capture-reference-request")!({ payload: { request: "r" } }));
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0].frame.references).toMatchObject([{ libraryId: recent[0].libraryId, imageId: recent[0].imageId }]);
  vi.unstubAllGlobals();
});
