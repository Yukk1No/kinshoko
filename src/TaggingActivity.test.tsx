import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { TaggingActivity } from "./TaggingActivity";
import { ToastProvider } from "./ui/Toast";

let actions: { command: string; libraryId: unknown }[];

/** 后端：`tagging_status` 按资料库回答；推送用 `push`。 */
function backend(statuses: Record<string, TaggingStatus>) {
  actions = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    const libraryId = (args as { libraryId?: string } | undefined)?.libraryId;
    actions.push({ command: cmd, libraryId });
    if (cmd === "tagging_status") return { libraryId, status: statuses[libraryId!] };
    return null;
  }, { shouldMockEvents: true });
}

const push = (status: TaggingStatus, libraryId = "L1") => act(() => emit("tagging-status", { libraryId, status }));

function mount(onOpenSettings = vi.fn(), libraryId = "L1", registered?: string[]) {
  const view = render(<ToastProvider><TaggingActivity libraryId={libraryId} registered={registered} onOpenSettings={onOpenSettings} /></ToastProvider>);
  return { ...view, onOpenSettings, rerender: (id: string, reg?: string[]) => view.rerender(<ToastProvider><TaggingActivity libraryId={id} registered={reg} onOpenSettings={onOpenSettings} /></ToastProvider>) };
}

const running = (tagged: number): TaggingStatus => ({ state: "running", model: "PixAI", device: "directMl", gpu: "RX 6500 XT", tagged });
const idle = (tagged: number): TaggingStatus => ({ state: "idle", model: "PixAI", device: "directMl", gpu: "RX 6500 XT", tagged });
const needsDownload = (downloaded = 0, cancelled = false): TaggingStatus => ({ state: "needsDownload", model: "PixAI", size: 992_916_002, downloaded, fallback: null, cancelled });
const downloading = (downloaded: number): TaggingStatus => ({ state: "downloading", model: "PixAI", downloaded, total: 1_000_000_000 });
/** 等待后端首次读取与订阅都到位，后面的推送才收得到。 */
const settled = () => waitFor(() => expect(actions.some((a) => a.command === "tagging_status")).toBe(true));
/** 正在显示的通知标题（Base UI 另有一份播报副本，不算）。 */
const toasts = () => [...document.querySelectorAll(".k-toast-title")].map((t) => t.textContent ?? "");
const shown = (pattern: RegExp) => toasts().filter((t) => pattern.test(t)).length;
const icon = () => screen.queryByRole("button", { name: /自动标签/ });

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("缩放滑块左边的打标图标", () => {
  it("打标时转动，悬停可见进度，点击打开设置 › 自动标签", async () => {
    backend({ L1: running(128) });
    const { onOpenSettings } = mount();
    const button = await screen.findByRole("button", { name: /自动标签：正在自动标签，已标 128 张（显卡）/ });
    expect(button.getAttribute("title")).toBe("正在自动标签，已标 128 张（显卡）");
    expect(button.dataset.activity).toBe("busy");
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("右下角收起时（#180）换成小圆点，状态仍可读", async () => {
    backend({ L1: running(128) });
    render(<ToastProvider><TaggingActivity collapsed libraryId="L1" onOpenSettings={() => {}} /></ToastProvider>);
    const dot = await screen.findByRole("img", { name: "自动标签：正在自动标签，已标 128 张（显卡）" });
    expect(dot.classList.contains("k-tagging-dot")).toBe(true);
    expect(dot.dataset.activity).toBe("busy");
    expect(icon()).toBeNull();
  });

  it.each<[string, TaggingStatus, string]>([
    ["下载", downloading(450_000_000), "正在下载自动标签模型 45%"],
    ["加载模型", { state: "starting" }, "正在加载自动标签模型"],
    ["校验模型", { state: "preparing", model: "PixAI" }, "正在校验自动标签模型"],
  ])("%s时转动并写出进度", async (_, status, text) => {
    backend({ L1: status });
    mount();
    const button = await screen.findByRole("button", { name: `自动标签：${text}，打开自动标签设置` });
    expect(button.dataset.activity).toBe("busy");
  });

  it("暂停时静止", async () => {
    backend({ L1: { state: "paused" } });
    mount();
    const button = await screen.findByRole("button", { name: /自动标签：已暂停/ });
    expect(button.dataset.activity).toBe("paused");
  });

  it("全屏程序在前台时静止，并说明是自动暂停（#212）", async () => {
    backend({ L1: { state: "yieldedToFullScreen" } });
    mount();
    const button = await screen.findByRole("button", { name: /自动标签：因全屏程序暂停/ });
    expect(button.dataset.activity).toBe("paused");
  });

  it.each<[string, TaggingStatus]>([
    ["打完", idle(3)],
    ["需要下载", needsDownload()],
    ["没有可用设备", { state: "noDevice", reason: { code: "taggerReported", detail: "没有独立显卡" } }],
    ["出错", { state: "failed", reason: { code: "taggerReported", detail: "超时" } }],
  ])("%s时不显示", async (_, status) => {
    backend({ L1: running(1) });
    mount();
    await screen.findByRole("button", { name: /自动标签/ });
    await push(status);
    await waitFor(() => expect(icon()).toBeNull());
  });

  it("切换可写资料库后不显示旧库的状态", async () => {
    backend({ L1: running(5), L2: idle(0) });
    mount(vi.fn(), "L1", ["L1", "L2"]);
    await screen.findByRole("button", { name: /已标 5 张/ });
    await act(() => emit("writable-library", { id: "L2", name: "私人收藏", root: "D:\\私人收藏" }));
    await waitFor(() => expect(icon()).toBeNull());
    await push(running(9), "L1");
    expect(icon()).toBeNull();
  });
});

describe("自动标签的右下角通知", () => {
  it("未下载模型时弹出带“下载”的通知，不自动消失；点下载后开始下载并改为提示去设置看进度", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ L1: needsDownload() });
    mount();
    expect(await screen.findByText("需要下载自动标签模型（993 MB）")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    const download = screen.getByRole("button", { name: "下载" });
    expect(actions.map((a) => a.command)).not.toContain("tagging_download");

    fireEvent.click(download);
    await waitFor(() => expect(actions).toContainEqual({ command: "tagging_download", libraryId: "L1" }));
    await waitFor(() => expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull());
    expect(await screen.findByText("正在下载自动标签模型")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(6_000); });
    await waitFor(() => expect(screen.queryByText("正在下载自动标签模型")).toBeNull());
  });
});

describe("“需要下载”通知的去重", () => {
  it("关掉后，本次启动内不再为这个资料库弹出", async () => {
    backend({ L1: needsDownload() });
    mount();
    await screen.findByText(/需要下载自动标签模型/);
    await push(needsDownload());
    expect(shown(/需要下载自动标签模型/)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() => expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull());
    await push(downloading(1));
    await push(needsDownload(1));
    expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull();
  });

  it("下载中取消（#213）后回到需要下载，本次启动内不再弹出", async () => {
    backend({ L1: downloading(100) });
    mount();
    await settled();
    await push(needsDownload(500_000_000, true));
    await push(needsDownload(500_000_000));
    expect(shown(/需要下载自动标签模型/)).toBe(0);
    expect(shown(/已下载自动标签模型/)).toBe(0);
  });

  it("下载过一部分时操作写“继续下载”；从别处开始下载后通知收起", async () => {
    backend({ L1: needsDownload(250_000_000) });
    mount();
    expect(await screen.findByRole("button", { name: "继续下载" })).toBeTruthy();
    await push(downloading(300_000_000));
    await waitFor(() => expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull());
  });
});

describe("完成类通知", () => {
  it("下载完成弹一次“已下载自动标签模型”，5 秒后消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ L1: downloading(100) });
    mount();
    await settled();
    await push(downloading(900_000_000));
    await push({ state: "preparing", model: "PixAI" });
    await push({ state: "starting" });
    await waitFor(() => expect(shown(/已下载自动标签模型/)).toBe(1));
    await act(async () => { vi.advanceTimersByTime(6_000); });
    await waitFor(() => expect(screen.queryByText("已下载自动标签模型")).toBeNull());
  });

  it.each<[string, TaggingStatus]>([
    ["出错", { state: "failed", reason: { code: "taggerReported", detail: "下载失败：超时" } }],
    ["中断回到需要下载", needsDownload(500_000_000)],
  ])("下载%s不算下载完成", async (_, next) => {
    backend({ L1: downloading(100) });
    mount();
    await settled();
    await push(next);
    await waitFor(() => expect(shown(/需要下载自动标签模型|下载失败/)).toBe(1));
    expect(shown(/已下载自动标签模型/)).toBe(0);
  });

  it("下载中暂停（#213）不算下载完成", async () => {
    backend({ L1: downloading(100) });
    mount();
    await settled();
    await push({ state: "paused" });
    expect(await screen.findByRole("button", { name: /自动标签：已暂停/ })).toBeTruthy();
    expect(shown(/已下载自动标签模型/)).toBe(0);
  });
});

describe("出错与不可用的通知去重", () => {
  it("出错时写出原因、不自动消失；后端反复重试时同一个原因只弹一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ L1: { state: "failed", reason: { code: "taggerReported", detail: "下载失败：超时" } } });
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("自动标签出错：下载失败：超时");
    await push({ state: "failed", reason: { code: "taggerReported", detail: "下载失败：超时" } });
    await push({ state: "failed", reason: { code: "taggerReported", detail: "下载失败：超时" } });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown(/下载失败：超时/)).toBe(1);

    await push({ state: "failed", reason: { code: "taggerReported", detail: "磁盘已满" } });
    await waitFor(() => expect(shown(/磁盘已满/)).toBe(1));
  });

  it("重试经过加载、打标或下载再失败时，同一个原因也只弹一次；打完一轮后再出错重新报", async () => {
    backend({ L1: { state: "failed", reason: { code: "taggerReported", detail: "打标子进程崩溃" } } });
    mount();
    await waitFor(() => expect(shown(/打标子进程崩溃/)).toBe(1));
    await push({ state: "starting" });
    await push(running(0));
    await push({ state: "failed", reason: { code: "taggerReported", detail: "打标子进程崩溃" } });
    await push(downloading(10));
    await push({ state: "failed", reason: { code: "taggerReported", detail: "打标子进程崩溃" } });
    expect(shown(/打标子进程崩溃/)).toBe(1);

    await push(idle(0));
    await push({ state: "failed", reason: { code: "taggerReported", detail: "打标子进程崩溃" } });
    await waitFor(() => expect(shown(/打标子进程崩溃/)).toBe(2));
  });

  it("不可用时写出原因、不自动消失；本次启动内同一个原因只弹一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ L1: { state: "noDevice", reason: { code: "taggerReported", detail: "内存不足" } } });
    mount();
    await waitFor(() => expect(toasts()).toEqual(["自动标签不可用：内存不足"]));
    await push({ state: "noDevice", reason: { code: "taggerReported", detail: "内存不足" } });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(shown(/内存不足/)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() => expect(shown(/内存不足/)).toBe(0));
    await push({ state: "starting" });
    await push({ state: "noDevice", reason: { code: "taggerReported", detail: "内存不足" } });
    await push({ state: "noDevice", reason: { code: "taggerReported", detail: "没有独立显卡" } });
    await waitFor(() => expect(toasts()).toEqual(["自动标签不可用：没有独立显卡"]));
  });
});

describe("一轮打完的通知", () => {
  it("打标结束进入空闲时弹出这一轮新打的张数，5 秒后消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 本次运行之前已经打过 10 张；Running 在打每张之前推送，最后一张由 Idle 带出。
    backend({ L1: idle(10) });
    mount();
    await settled();
    await push(running(10));
    await push(running(11));
    await push(idle(12));
    await push(idle(12));
    await waitFor(() => expect(toasts()).toEqual(["自动标签：新打了 2 张"]));
    await act(async () => { vi.advanceTimersByTime(6_000); });
    await waitFor(() => expect(toasts()).toEqual([]));
  });

  it("这一轮一张也没打成时不弹", async () => {
    backend({ L1: idle(4) });
    mount();
    await settled();
    await push(running(4));
    await push(idle(4));
    await push({ state: "failed", reason: { code: "taggerReported", detail: "看得见的下一条" } });
    await waitFor(() => expect(shown(/看得见的下一条/)).toBe(1));
    expect(shown(/新打了/)).toBe(0);
  });
});

describe("切换可写资料库", () => {
  it("不弹出旧库迟到的通知，旧库的“需要下载”通知收起", async () => {
    backend({ L1: needsDownload(), L2: running(3) });
    mount(vi.fn(), "L1", ["L1", "L2"]);
    await waitFor(() => expect(shown(/需要下载自动标签模型/)).toBe(1));

    await act(() => emit("writable-library", { id: "L2", name: "私人收藏", root: "D:\\私人收藏" }));
    await screen.findByRole("button", { name: /已标 3 张/ });
    await waitFor(() => expect(shown(/需要下载自动标签模型/)).toBe(0));
    await push({ state: "failed", reason: { code: "taggerReported", detail: "旧库打标失败" } }, "L1");
    await push({ state: "noDevice", reason: { code: "taggerReported", detail: "旧库没有显卡" } }, "L1");
    await push(idle(4), "L2");
    await waitFor(() => expect(toasts()).toEqual(["自动标签：新打了 1 张"]));
  });
});
