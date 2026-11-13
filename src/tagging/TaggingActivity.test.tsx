import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { tipText } from "../test/tip";
import { emit } from "@tauri-apps/api/event";
import type { TaggingStatus } from "../bindings/TaggingStatus";
import { TaggingActivity } from "./TaggingActivity";
import { fakeBackend, type FakeBackend } from "../test/backend";

let fake: FakeBackend;
/** 前端发出的命令，按先后。 */
const actions = () => fake.calls();

/** 后端：`tagging_status` 回答所有资料库合计的状态（#414）；推送用 `push`。 */
function backend(status: TaggingStatus) {
  fake = fakeBackend({
    tagging_status: status,
    tagging_pause: null,
    tagging_resume: null,
    tagging_download: null,
    tagging_retry_failed: null,
  });
}

const push = (status: TaggingStatus) => act(() => emit("tagging-status", status));

function mount(onOpenSettings = vi.fn()) {
  const view = render(
    <>
      <TaggingActivity onOpenSettings={onOpenSettings} />
    </>,
  );
  return { ...view, onOpenSettings };
}

const running = (tagged: number, done = 0, remaining = 1): TaggingStatus => ({
  state: "running",
  model: "PixAI",
  device: "directMl",
  gpu: "RX 6500 XT",
  tagged,
  done,
  remaining,
});
const idle = (tagged: number): TaggingStatus => ({
  state: "idle",
  model: "PixAI",
  device: "directMl",
  gpu: "RX 6500 XT",
  tagged,
  unknown: 0,
  failed: { unreadable: 0, crashed: 0 },
});
const needsDownload = (downloaded = 0, cancelled = false): TaggingStatus => ({
  state: "needsDownload",
  model: "PixAI",
  size: 992_916_002,
  downloaded,
  fallback: null,
  cancelled,
});
const downloading = (downloaded: number): TaggingStatus => ({
  state: "downloading",
  model: "PixAI",
  downloaded,
  total: 1_000_000_000,
});
/** 等待后端首次读取与订阅都到位，后面的推送才收得到。 */
const settled = () => waitFor(() => expect(actions().some((a) => a.command === "tagging_status")).toBe(true));
/** 正在显示的通知标题（Base UI 另有一份播报副本，不算）。 */
const toasts = () => [...document.querySelectorAll(".k-toast-title")].map((t) => t.textContent ?? "");
const shown = (pattern: RegExp) => toasts().filter((t) => pattern.test(t)).length;
const icon = () => screen.queryByRole("button", { name: /自动标签/ });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("缩放滑块左边的打标图标", () => {
  it("打标时显示还剩几张，点击暂停（#475），不打开设置", async () => {
    backend(running(128, 0, 88));
    const { onOpenSettings } = mount();
    const button = await screen.findByRole("button", { name: "暂停自动标签：还剩 88 张" });
    expect(await tipText(button)).toBe("还剩 88 张");
    expect(button.dataset.activity).toBe("busy");
    // 悬停时图标变成暂停：两枚图标叠在一起，CSS 切换。
    expect(button.querySelector(".k-tagging-next")).not.toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(actions().some((a) => a.command === "tagging_pause")).toBe(true));
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("点击后命令失败时提示原因（#529）", async () => {
    backend(running(128, 0, 88));
    fake.on("tagging_pause", () => {
      throw { code: "message", message: "子进程没有回应" };
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "暂停自动标签：还剩 88 张" }));
    await waitFor(() => expect(toasts()).toContain("自动标签操作没有完成：子进程没有回应"));
  });

  it("暂停时点击继续，标签留着暂停前还剩的张数", async () => {
    backend(running(10, 0, 88));
    mount();
    await screen.findByRole("button", { name: /还剩 88 张/ });
    await push({ state: "paused" });
    const button = await screen.findByRole("button", { name: "继续自动标签：已暂停，还剩 88 张" });
    fireEvent.click(button);
    await waitFor(() => expect(actions().some((a) => a.command === "tagging_resume")).toBe(true));
  });

  it("打完几张后按最近几张的用时写出预计用时；暂停时留着", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    backend(running(0, 0, 100));
    mount();
    await screen.findByRole("button", { name: "暂停自动标签：还剩 100 张" });
    for (let done = 1; done <= 3; done++) {
      now += 6_000;
      await push(running(done, done, 100 - done));
    }
    // 每张 6 秒，还剩 97 张：约 10 分钟。
    await screen.findByRole("button", { name: "暂停自动标签：还剩 97 张，约 10 分钟" });
    await push({ state: "paused" });
    await screen.findByRole("button", { name: "继续自动标签：已暂停，还剩 97 张，约 10 分钟" });
  });

  it("右键只有自动标签设置", async () => {
    backend(running(1));
    const { onOpenSettings } = mount();
    fireEvent.contextMenu(await screen.findByRole("button", { name: /暂停自动标签/ }), { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "自动标签设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "忽略" })).toBeNull();
  });

  it("右下角收起时（#180）换成小圆点，状态仍可读", async () => {
    backend(running(128));
    render(
      <>
        <TaggingActivity collapsed onOpenSettings={() => {}} />
      </>,
    );
    const dot = await screen.findByRole("img", { name: "自动标签：还剩 1 张" });
    expect(dot.classList.contains("k-tagging-dot")).toBe(true);
    expect(dot.dataset.activity).toBe("busy");
    expect(icon()).toBeNull();
  });

  it.each<[string, TaggingStatus, string]>([
    ["下载", downloading(450_000_000), "正在下载自动标签模型 45%"],
    ["加载模型", { state: "starting" }, "正在加载自动标签模型"],
    ["校验模型", { state: "preparing", model: "PixAI" }, "正在校验自动标签模型"],
  ])("%s时显示并写出进度，点击暂停", async (_, status, text) => {
    backend(status);
    mount();
    const button = await screen.findByRole("button", { name: `暂停自动标签：${text}` });
    expect(button.dataset.activity).toBe("busy");
  });

  it("暂停时显示暂停", async () => {
    backend({ state: "paused" });
    mount();
    const button = await screen.findByRole("button", { name: /自动标签：已暂停/ });
    expect(button.dataset.activity).toBe("paused");
  });

  it("全屏程序在前台时显示暂停，并说明是自动暂停（#212）", async () => {
    backend({ state: "yieldedToFullScreen" });
    mount();
    const button = await screen.findByRole("button", { name: /自动标签：因全屏程序暂停/ });
    expect(button.dataset.activity).toBe("paused");
  });

  it("外圈进度环（#372）：下载看字节，打标看这一轮处理过的张数，暂停时停在原处", async () => {
    const arc = () => document.querySelector(".k-tagging-arc")?.getAttribute("stroke-dasharray");
    backend(downloading(450_000_000));
    mount();
    await screen.findByRole("button", { name: /45%/ });
    expect(arc()).toBe("45 100");
    await push(running(40, 1, 3));
    await waitFor(() => expect(arc()).toBe("25 100"));
    await push({ state: "paused" });
    await screen.findByRole("button", { name: /已暂停/ });
    expect(arc()).toBe("25 100");
    await push({ state: "yieldedToFullScreen" });
    await screen.findByRole("button", { name: /因全屏程序暂停/ });
    expect(arc()).toBe("25 100");
  });

  it("加载模型时没有进度，只有整圈底环", async () => {
    backend({ state: "starting" });
    mount();
    const button = await screen.findByRole("button", { name: /正在加载自动标签模型/ });
    expect(button.dataset.pending).toBe("true");
    expect(document.querySelector(".k-tagging-arc")).toBeNull();
  });

  it("多选收起时右上角是迷你进度环", async () => {
    backend(running(10, 1, 1));
    render(
      <>
        <TaggingActivity collapsed onOpenSettings={() => {}} />
      </>,
    );
    const dot = await screen.findByRole("img", { name: /还剩 1 张/ });
    expect(dot.querySelector(".k-tagging-arc")?.getAttribute("stroke-dasharray")).toBe("50 100");
  });

  it("打完时不显示", async () => {
    backend(running(1));
    mount();
    await screen.findByRole("button", { name: /自动标签/ });
    await push(idle(3));
    await waitFor(() => expect(icon()).toBeNull());
  });

  // 停住、等画师处理的状态留一个静止图标：关掉通知后仍能从这里去设置。
  it.each<[string, TaggingStatus, RegExp]>([
    ["需要下载", needsDownload(), /需要下载自动标签模型/],
    ["没有可用设备", { state: "noDevice", reasons: [{ code: "system", detail: "没有独立显卡" }] }, /自动标签不可用/],
    ["出错", { state: "failed", reason: { code: "system", detail: "超时" } }, /自动标签出错/],
  ])("%s时留一个静止图标，点开去设置", async (_, status, name) => {
    const onOpenSettings = vi.fn();
    backend(status);
    mount(onOpenSettings);
    const button = await screen.findByRole("button", { name });
    expect(button.dataset.activity).toBe("stopped");
    expect(button.dataset.pending).toBeUndefined();
    expect(document.querySelector(".k-tagging-arc")).toBeNull();
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("停住的状态没有动作，悬停不变形", async () => {
    backend(needsDownload());
    mount();
    const button = await screen.findByRole("button", { name: /需要下载自动标签模型，打开自动标签设置/ });
    expect(button.querySelector(".k-tagging-next")).toBeNull();
  });

  it("停住的状态在多选收起时不挂小圆点", async () => {
    backend(needsDownload());
    render(
      <>
        <TaggingActivity collapsed onOpenSettings={() => {}} />
      </>,
    );
    await settled();
    await act(async () => {});
    expect(document.querySelector(".k-tagging-dot")).toBeNull();
  });
});

describe("自动标签的右下角通知", () => {
  it("未下载模型时弹出带“下载”的通知，不自动消失；点下载后开始下载并改为提示去设置看进度", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend(needsDownload());
    mount();
    expect(await screen.findByText("需要下载自动标签模型（947 MB）")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    const download = screen.getByRole("button", { name: "下载" });
    expect(actions().map((a) => a.command)).not.toContain("tagging_download");

    fireEvent.click(download);
    await waitFor(() => expect(actions().map((a) => a.command)).toContain("tagging_download"));
    await waitFor(() => expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull());
    expect(await screen.findByText("正在下载自动标签模型")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await waitFor(() => expect(screen.queryByText("正在下载自动标签模型")).toBeNull());
  });
});

describe("“需要下载”通知的去重", () => {
  it("关掉后，本次启动内不再弹出", async () => {
    backend(needsDownload());
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
    backend(downloading(100));
    mount();
    await settled();
    await push(needsDownload(500_000_000, true));
    await push(needsDownload(500_000_000));
    expect(shown(/需要下载自动标签模型/)).toBe(0);
    expect(shown(/已下载自动标签模型/)).toBe(0);
  });

  it("下载过一部分时操作写“继续下载”；从别处开始下载后通知收起", async () => {
    backend(needsDownload(250_000_000));
    mount();
    expect(await screen.findByRole("button", { name: "继续下载" })).toBeTruthy();
    await push(downloading(300_000_000));
    await waitFor(() => expect(screen.queryByText(/需要下载自动标签模型/)).toBeNull());
  });
});

describe("完成类通知", () => {
  it("下载完成弹一次“已下载自动标签模型”，5 秒后消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend(downloading(100));
    mount();
    await settled();
    await push(downloading(900_000_000));
    await push({ state: "preparing", model: "PixAI" });
    await push({ state: "starting" });
    await waitFor(() => expect(shown(/已下载自动标签模型/)).toBe(1));
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await waitFor(() => expect(screen.queryByText("已下载自动标签模型")).toBeNull());
  });

  it.each<[string, TaggingStatus]>([
    ["出错", { state: "failed", reason: { code: "system", detail: "下载失败：超时" } }],
    ["中断回到需要下载", needsDownload(500_000_000)],
  ])("下载%s不算下载完成", async (_, next) => {
    backend(downloading(100));
    mount();
    await settled();
    await push(next);
    await waitFor(() => expect(shown(/需要下载自动标签模型|下载失败/)).toBe(1));
    expect(shown(/已下载自动标签模型/)).toBe(0);
  });

  it("下载中暂停（#213）不算下载完成", async () => {
    backend(downloading(100));
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
    backend({ state: "failed", reason: { code: "system", detail: "下载失败：超时" } });
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain("自动标签出错：下载失败：超时");
    await push({ state: "failed", reason: { code: "system", detail: "下载失败：超时" } });
    await push({ state: "failed", reason: { code: "system", detail: "下载失败：超时" } });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown(/下载失败：超时/)).toBe(1);

    await push({ state: "failed", reason: { code: "system", detail: "磁盘已满" } });
    await waitFor(() => expect(shown(/磁盘已满/)).toBe(1));
  });

  it("重试经过加载、打标或下载再失败时，同一个原因也只弹一次；打完一轮后再出错重新报", async () => {
    backend({ state: "failed", reason: { code: "system", detail: "打标子进程崩溃" } });
    mount();
    await waitFor(() => expect(shown(/打标子进程崩溃/)).toBe(1));
    await push({ state: "starting" });
    await push(running(0));
    await push({ state: "failed", reason: { code: "system", detail: "打标子进程崩溃" } });
    await push(downloading(10));
    await push({ state: "failed", reason: { code: "system", detail: "打标子进程崩溃" } });
    expect(shown(/打标子进程崩溃/)).toBe(1);

    await push(idle(0));
    await push({ state: "failed", reason: { code: "system", detail: "打标子进程崩溃" } });
    await waitFor(() => expect(shown(/打标子进程崩溃/)).toBe(2));
  });

  it("不可用时写出原因、不自动消失；本次启动内同一个原因只弹一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ state: "noDevice", reasons: [{ code: "system", detail: "内存不足" }] });
    mount();
    await waitFor(() => expect(toasts()).toEqual(["自动标签不可用：内存不足"]));
    await push({ state: "noDevice", reasons: [{ code: "system", detail: "内存不足" }] });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown(/内存不足/)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    await waitFor(() => expect(shown(/内存不足/)).toBe(0));
    await push({ state: "starting" });
    await push({ state: "noDevice", reasons: [{ code: "system", detail: "内存不足" }] });
    await push({ state: "noDevice", reasons: [{ code: "system", detail: "没有独立显卡" }] });
    await waitFor(() => expect(toasts()).toEqual(["自动标签不可用：没有独立显卡"]));
  });
});

describe("一轮打完的通知", () => {
  it("打标结束进入空闲时弹出这一轮新打的张数，5 秒后消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 本次运行之前已经打过 10 张；Running 在打每张之前推送，最后一张由 Idle 带出。
    backend(idle(10));
    mount();
    await settled();
    await push(running(10));
    await push(running(11));
    await push(idle(12));
    await push(idle(12));
    await waitFor(() => expect(toasts()).toEqual(["自动标签：已完成 2 张"]));
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await waitFor(() => expect(toasts()).toEqual([]));
  });

  it("这一轮一张也没打成时不弹", async () => {
    backend(idle(4));
    mount();
    await settled();
    await push(running(4));
    await push(idle(4));
    await push({ state: "failed", reason: { code: "system", detail: "看得见的下一条" } });
    await waitFor(() => expect(shown(/看得见的下一条/)).toBe(1));
    expect(shown(/新打了/)).toBe(0);
  });
});
