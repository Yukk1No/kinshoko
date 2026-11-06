import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { AutoTaggingSettings } from "./AutoTaggingSettings";
import { chooseOption, optionNames } from "./test/select";

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  delete window.__KINSHOKO_TEST_PICKS__;
});

const choice: ModelChoice = {
  model: "PixAI Tagger v1.0",
  selected: null,
  options: [
    { device: "directMl", vramNeed: 1_800_000_000, ramNeed: 0, size: 992_916_002, downloaded: true },
    { device: "cpu", vramNeed: 0, ramNeed: 5_000_000_000, size: 1_984_062_544, downloaded: false },
  ],
};

type Call = { cmd: string; args: Record<string, unknown> };

function backend({ status = { state: "paused" } as TaggingStatus, models = choice, handle = (() => undefined) as (cmd: string, args: Record<string, unknown>) => unknown } = {}) {
  const calls: Call[] = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    const handled = handle(cmd, a);
    if (handled !== undefined) return handled;
    if (cmd === "tagging_models") return models;
    if (cmd === "tagging_status") return status;
    return null;
  }, { shouldMockEvents: true });
  return calls;
}

const statusRow = () => screen.getByRole("listitem", { name: "状态" });
const hardware = () => screen.findByRole("combobox", { name: "硬件加速" });

describe("设置 › 自动标签 › 自动打标", () => {
  it.each<[string, TaggingStatus, RegExp, string | null]>([
    ["加载模型", { state: "starting" }, /正在加载模型…/, "暂停"],
    ["校验模型", { state: "preparing", model: "PixAI Tagger v1.0 (GPU)" }, /正在加载模型…/, "暂停"],
    ["打标", { state: "running", model: "x", device: "directMl", gpu: "RX 6500 XT", tagged: 12, done: 0, remaining: 30 }, /已标 12 张，还剩 30 张（显卡）/, "暂停"],
    ["暂停", { state: "paused" }, /已暂停/, "继续"],
    ["全屏程序在前台", { state: "yieldedToFullScreen" }, /因全屏程序或演示模式暂停，回到桌面后自动继续/, "暂停"],
    ["打完", { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0, unknown: 0 }, /已全部打完/, null],
    // 有图库暂时打不开、数不出还剩几张时，不报已全部打完（#414）。
    ["有图库打不开", { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0, unknown: 1 }, /^1 个图库暂时打不开$/, null],
    ["没有可用设备", { state: "noDevice", reasons: [{ code: "taggingNoGpu" }, { code: "taggingRamShort", need: "5.4 GB" }] }, /自动标签不可用：没有独立显卡；可用内存不够（需要约 5.4 GB）/, null],
    ["出错", { state: "failed", reason: { code: "downloadFailed", detail: "超时" } }, /下载失败：超时.*稍后会自动重试/, null],
  ])("%s时显示对应的状态与操作", async (_, status, text, action) => {
    backend({ status });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(() => expect(within(statusRow()).getByText(text)).toBeTruthy());
    const buttons = within(statusRow()).queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(action === null ? [] : [action]);
  });

  it("首次使用显示需要下载的大小，确认后才下载", async () => {
    const calls = backend({ status: { state: "needsDownload", model: "x", size: 992_916_002, downloaded: 0, fallback: null, cancelled: false } });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(() => expect(within(statusRow()).getByText(/需要下载模型（947 MB）/)).toBeTruthy());
    expect(calls.some((c) => c.cmd === "tagging_download")).toBe(false);
    fireEvent.click(within(statusRow()).getByRole("button", { name: "下载" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_download", args: {} }));
  });

  it("下载过一部分时按钮是继续下载", async () => {
    backend({ status: { state: "needsDownload", model: "x", size: 1_000_000_000, downloaded: 250_000_000, fallback: null, cancelled: false } });
    render(<AutoTaggingSettings hasLibrary />);
    expect(await screen.findByRole("button", { name: "继续下载（已下载 25%）" })).toBeTruthy();
  });

  it("自动档退回 CPU 时写明原因与要下载的大小", async () => {
    backend({ status: { state: "needsDownload", model: "x", size: 1_984_062_544, downloaded: 0, fallback: [{ code: "taggingGpuUnreliable" }], cancelled: false } });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(() => expect(within(statusRow()).getByText("显卡不可用：显卡多次出错，本次不再使用，改用 CPU 需下载 1.8 GB")).toBeTruthy());
    expect(within(statusRow()).getByRole("button", { name: "下载" })).toBeTruthy();
  });

  it("下载中显示进度条、百分比与已下载／总大小", async () => {
    backend({ status: { state: "starting" } });
    render(<AutoTaggingSettings hasLibrary />);
    await screen.findByText(/正在加载模型…/);
    await act(() => emit("tagging-status", { state: "downloading", model: "x", downloaded: 500_000_000, total: 1_000_000_000 }));
    expect(await within(statusRow()).findByText("正在下载模型 50%（477 MB / 954 MB）")).toBeTruthy();
    expect(within(statusRow()).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("下载中可以暂停或取消（#213）", async () => {
    const calls = backend({ status: { state: "downloading", model: "x", downloaded: 1, total: 2 } });
    render(<AutoTaggingSettings hasLibrary />);
    fireEvent.click(await within(statusRow()).findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_pause", args: {} }));
    fireEvent.click(within(statusRow()).getByRole("button", { name: "取消下载" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_cancel_download", args: {} }));
  });

  it("暂停与继续", async () => {
    const calls = backend({ status: { state: "running", model: "x", device: "cpu", gpu: null, tagged: 0, done: 0, remaining: 1 } });
    render(<AutoTaggingSettings hasLibrary />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_pause", args: {} }));
    await act(() => emit("tagging-status", { state: "paused" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_resume", args: {} }));
  });

  it("打开的图库读不到、别的图库照常打标时，状态与暂停照常显示（#414）", async () => {
    backend({ status: { state: "running", model: "x", device: "cpu", gpu: null, tagged: 3, done: 0, remaining: 9 } });
    render(<AutoTaggingSettings hasLibrary={false} />);
    await waitFor(() => expect(within(statusRow()).getByText(/已标 3 张，还剩 9 张/)).toBeTruthy());
    expect(within(statusRow()).getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("还没有资料库时说明打开图库后才开始", async () => {
    backend({ status: { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0, unknown: 0 } });
    render(<AutoTaggingSettings hasLibrary={false} />);
    await waitFor(() => expect(within(statusRow()).getByText("添加图库后开始")).toBeTruthy());
  });
});

describe("设置 › 自动标签 › 模型", () => {
  it("模型只读显示，没有下拉框", async () => {
    backend();
    render(<AutoTaggingSettings hasLibrary />);
    const row = await screen.findByRole("listitem", { name: "模型" });
    expect(within(row).getByText("PixAI Tagger v1.0")).toBeTruthy();
    expect(within(row).queryByRole("combobox")).toBeNull();
  });

  it("硬件加速有自动、显卡、CPU 三项，注明需求与是否已下载，不出现精度字样", async () => {
    backend();
    render(<AutoTaggingSettings hasLibrary />);
    const select = await hardware();
    expect(select.textContent).toBe("自动");
    expect(await optionNames(select)).toEqual(["自动", "显卡，显存约 1.7 GB，已下载", "CPU，内存约 4.7 GB，需下载 1.8 GB"]);
    expect(document.body.textContent).not.toMatch(/FP16|FP32|精度/);
  });

  it("选自动时写出实际在用的档", async () => {
    backend({ status: { state: "running", model: "x", device: "directMl", gpu: "AMD Radeon RX 6500 XT", tagged: 1, done: 0, remaining: 1 } });
    render(<AutoTaggingSettings hasLibrary />);
    await hardware();
    expect(await screen.findByText("自动：当前用显卡（AMD Radeon RX 6500 XT）")).toBeTruthy();
  });

  it("选自动而还没决定时写有独显时用显卡", async () => {
    backend({ status: { state: "starting" } });
    render(<AutoTaggingSettings hasLibrary />);
    await hardware();
    expect(await screen.findByText("自动：有独显时用显卡")).toBeTruthy();
  });

  it("选一档即保存，并显示这一档的需求", async () => {
    const calls = backend({ handle: (cmd, args) => (cmd === "tagging_set_device" ? { ...choice, selected: args.device } : undefined) });
    render(<AutoTaggingSettings hasLibrary />);
    await chooseOption(await hardware(), /^CPU/);
    await waitFor(async () => expect((await hardware()).textContent).toMatch(/^CPU/));
    expect(calls.find((c) => c.cmd === "tagging_set_device")?.args).toEqual({ device: "cpu" });
    expect(screen.getByText("CPU，内存约 4.7 GB，需下载 1.8 GB", { selector: ".k-list-meta" })).toBeTruthy();

    await chooseOption(await hardware(), "自动");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "tagging_set_device").at(-1)?.args).toEqual({ device: null }));
  });

  it("换档之前开始的重新读取晚到时，不把刚选的档盖回去", async () => {
    let release = () => {};
    let reads = 0;
    backend({
      handle: (cmd, args) => {
        if (cmd === "tagging_set_device") return { ...choice, selected: args.device };
        // 第一次读取立即返回；之后（状态到达触发的重新读取）等换档完成后才送回换档前的结果。
        if (cmd === "tagging_models" && reads++ > 0) return new Promise((done) => { release = () => done(choice); });
        return undefined;
      },
    });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(() => expect(reads).toBe(2));
    await chooseOption(await hardware(), /^CPU/);
    await waitFor(async () => expect((await hardware()).textContent).toMatch(/^CPU/));
    await act(async () => { release(); });
    expect((await hardware()).textContent).toMatch(/^CPU/);
  });

  it("下载完成后重新读取各档是否已下载", async () => {
    let downloaded = false;
    backend({
      status: { state: "downloading", model: "x", downloaded: 1, total: 2 },
      handle: (cmd) => (cmd === "tagging_models" ? { ...choice, options: [choice.options[0], { ...choice.options[1], downloaded }] } : undefined),
    });
    render(<AutoTaggingSettings hasLibrary />);
    await waitFor(async () => expect(await optionNames(await hardware())).toContainEqual(expect.stringMatching(/CPU，.*需下载/)));
    downloaded = true;
    await act(() => emit("tagging-status", { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0, unknown: 0 }));
    await waitFor(async () => expect(await optionNames(await hardware())).toContain("CPU，内存约 4.7 GB，已下载"));
  });

  it("从文件导入模型包，校验通过后显示已下载", async () => {
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\离线\\pixai.zip"];
    const calls = backend({
      handle: (cmd) => (cmd === "tagging_import_package" ? { ...choice, options: [choice.options[0], { ...choice.options[1], downloaded: true }] } : undefined),
    });
    render(<AutoTaggingSettings hasLibrary />);
    fireEvent.click(await screen.findByRole("button", { name: "导入模型包…" }));
    expect(await screen.findByText("模型包已导入并通过校验")).toBeTruthy();
    expect(await optionNames(await hardware())).toContain("CPU，内存约 4.7 GB，已下载");
    expect(calls.find((c) => c.cmd === "tagging_import_package")?.args).toEqual({ path: "D:\\离线\\pixai.zip" });
  });

  it("模型包校验不过时显示原因", async () => {
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\坏包.zip"];
    backend({
      handle: (cmd) => {
        if (cmd === "tagging_import_package") throw "模型包校验失败：model.onnx 已损坏";
        return undefined;
      },
    });
    render(<AutoTaggingSettings hasLibrary />);
    fireEvent.click(await screen.findByRole("button", { name: "导入模型包…" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("模型包校验失败：model.onnx 已损坏")).toBeTruthy();
  });
});
