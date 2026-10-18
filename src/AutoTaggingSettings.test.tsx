import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { ModelChoice } from "./bindings/ModelChoice";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { AutoTaggingSettings } from "./AutoTaggingSettings";

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
    if (cmd === "tagging_status") return { libraryId: a.libraryId, status };
    return null;
  }, { shouldMockEvents: true });
  return calls;
}

const statusRow = () => screen.getByRole("listitem", { name: "打标状态" });
const hardware = () => screen.findByRole<HTMLSelectElement>("combobox", { name: "硬件加速" });

describe("设置 › 自动标签 › 自动打标", () => {
  it.each<[string, TaggingStatus, RegExp, string | null]>([
    ["加载模型", { state: "starting" }, /正在加载模型…/, "暂停"],
    ["校验模型", { state: "preparing", model: "PixAI Tagger v1.0（显卡）" }, /正在加载模型…/, "暂停"],
    ["打标", { state: "running", model: "x", device: "directMl", gpu: "RX 6500 XT", tagged: 12 }, /正在打标 · 显卡 · 已打 12 张/, "暂停"],
    ["暂停", { state: "paused" }, /已暂停/, "继续"],
    ["打完", { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0 }, /已全部打完/, null],
    ["没有可用设备", { state: "noDevice", reason: "没有独立显卡" }, /自动标签不可用：没有独立显卡/, null],
    ["出错", { state: "failed", reason: "下载失败：超时" }, /下载失败：超时.*稍后会自动重试/, null],
  ])("%s时显示对应的状态与操作", async (_, status, text, action) => {
    backend({ status });
    render(<AutoTaggingSettings libraryId="L1" />);
    await waitFor(() => expect(within(statusRow()).getByText(text)).toBeTruthy());
    const buttons = within(statusRow()).queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(action === null ? [] : [action]);
  });

  it("首次使用显示需要下载的大小，确认后才下载", async () => {
    const calls = backend({ status: { state: "needsDownload", model: "x", size: 992_916_002, downloaded: 0, fallback: null } });
    render(<AutoTaggingSettings libraryId="L1" />);
    await waitFor(() => expect(within(statusRow()).getByText(/需要下载模型（993 MB）/)).toBeTruthy());
    expect(calls.some((c) => c.cmd === "tagging_download")).toBe(false);
    fireEvent.click(within(statusRow()).getByRole("button", { name: "下载" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_download", args: { libraryId: "L1" } }));
  });

  it("下载过一部分时按钮是继续下载", async () => {
    backend({ status: { state: "needsDownload", model: "x", size: 1_000_000_000, downloaded: 250_000_000, fallback: null } });
    render(<AutoTaggingSettings libraryId="L1" />);
    expect(await screen.findByRole("button", { name: "继续下载（已下载 25%）" })).toBeTruthy();
  });

  it("自动档退回 CPU 时写明原因与要下载的大小", async () => {
    backend({ status: { state: "needsDownload", model: "x", size: 1_984_062_544, downloaded: 0, fallback: "显卡多次出错，本次不再使用" } });
    render(<AutoTaggingSettings libraryId="L1" />);
    await waitFor(() => expect(within(statusRow()).getByText("显卡不可用：显卡多次出错，本次不再使用，改用 CPU 需下载 1984 MB")).toBeTruthy());
    expect(within(statusRow()).getByRole("button", { name: "下载" })).toBeTruthy();
  });

  it("下载中显示进度条、百分比与已下载／总大小", async () => {
    backend({ status: { state: "starting" } });
    render(<AutoTaggingSettings libraryId="L1" />);
    await screen.findByText(/正在加载模型…/);
    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "downloading", model: "x", downloaded: 500_000_000, total: 1_000_000_000 } }));
    expect(await within(statusRow()).findByText("正在下载模型 50%（500 MB / 1000 MB）")).toBeTruthy();
    expect(within(statusRow()).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("暂停与继续都发给打标所在的资料库", async () => {
    const calls = backend({ status: { state: "running", model: "x", device: "cpu", gpu: null, tagged: 0 } });
    render(<AutoTaggingSettings libraryId="L1" />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_pause", args: { libraryId: "L1" } }));
    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "paused" } }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "tagging_resume", args: { libraryId: "L1" } }));
  });

  it("跟着后端的可写资料库走，旧库迟到的状态不显示", async () => {
    const statuses: Record<string, TaggingStatus> = { L1: { state: "paused" }, L2: { state: "running", model: "x", device: "cpu", gpu: null, tagged: 7 } };
    backend({ handle: (cmd, args) => (cmd === "tagging_status" ? { libraryId: args.libraryId, status: statuses[args.libraryId as string] } : undefined) });
    render(<AutoTaggingSettings libraryId="L1" />);
    await waitFor(() => expect(within(statusRow()).getByText(/已暂停/)).toBeTruthy());

    await act(() => emit("writable-library", { id: "L2", name: "私人收藏", root: "D:\\私人收藏" }));
    expect(await within(statusRow()).findByText(/已打 7 张/)).toBeTruthy();
    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "failed", reason: "旧库打标失败" } }));
    expect(screen.queryByText(/旧库打标失败/)).toBeNull();
  });

  it("打标切到另一个资料库后，不再显示旧库的状态", async () => {
    backend({ handle: (cmd, args) => (cmd === "tagging_status" && args.libraryId === "L2" ? new Promise(() => {}) : undefined) });
    render(<AutoTaggingSettings libraryId="L1" />);
    await waitFor(() => expect(within(statusRow()).getByText("已暂停")).toBeTruthy());

    await act(() => emit("writable-library", { id: "L2", name: "私人收藏", root: "D:\\私人收藏" }));

    await waitFor(() => expect(within(statusRow()).getByText("正在读取…")).toBeTruthy());
    expect(within(statusRow()).queryByRole("button")).toBeNull();
  });

  it("还没有资料库时说明打开图库后才开始", async () => {
    backend();
    render(<AutoTaggingSettings libraryId={null} />);
    await waitFor(() => expect(within(statusRow()).getByText("添加图库后开始自动打标")).toBeTruthy());
  });
});

describe("设置 › 自动标签 › 模型", () => {
  it("Tagger 模型只读显示，没有下拉框", async () => {
    backend();
    render(<AutoTaggingSettings libraryId="L1" />);
    const row = await screen.findByRole("listitem", { name: "Tagger 模型" });
    expect(within(row).getByText("PixAI Tagger v1.0")).toBeTruthy();
    expect(within(row).queryByRole("combobox")).toBeNull();
  });

  it("硬件加速有自动、显卡、CPU 三项，注明需求与是否已下载，不出现精度字样", async () => {
    backend();
    render(<AutoTaggingSettings libraryId="L1" />);
    const select = await hardware();
    const options = within(select).getAllByRole<HTMLOptionElement>("option").map((o) => o.textContent);
    expect(options).toEqual(["自动", "显卡 · 显存约 1.8 GB · 已下载", "CPU · 内存约 5.0 GB · 需下载 1984 MB"]);
    expect(select.value).toBe("auto");
    expect(document.body.textContent).not.toMatch(/FP16|FP32|精度/);
  });

  it("选自动时写出实际在用的档", async () => {
    backend({ status: { state: "running", model: "x", device: "directMl", gpu: "AMD Radeon RX 6500 XT", tagged: 1 } });
    render(<AutoTaggingSettings libraryId="L1" />);
    await hardware();
    expect(await screen.findByText("自动：当前用显卡（AMD Radeon RX 6500 XT）")).toBeTruthy();
  });

  it("选自动而还没决定时写有独显时用显卡", async () => {
    backend({ status: { state: "starting" } });
    render(<AutoTaggingSettings libraryId="L1" />);
    await hardware();
    expect(await screen.findByText("自动：有独显时用显卡")).toBeTruthy();
  });

  it("选一档即保存，并显示这一档的需求", async () => {
    const calls = backend({ handle: (cmd, args) => (cmd === "tagging_set_device" ? { ...choice, selected: args.device } : undefined) });
    render(<AutoTaggingSettings libraryId="L1" />);
    fireEvent.change(await hardware(), { target: { value: "cpu" } });
    await waitFor(async () => expect((await hardware()).value).toBe("cpu"));
    expect(calls.find((c) => c.cmd === "tagging_set_device")?.args).toEqual({ device: "cpu" });
    expect(screen.getByText("CPU · 内存约 5.0 GB · 需下载 1984 MB", { selector: ".k-list-desc" })).toBeTruthy();

    fireEvent.change(await hardware(), { target: { value: "auto" } });
    await waitFor(() => expect(calls.filter((c) => c.cmd === "tagging_set_device").at(-1)?.args).toEqual({ device: null }));
  });

  it("下载完成后重新读取各档是否已下载", async () => {
    let downloaded = false;
    backend({
      status: { state: "downloading", model: "x", downloaded: 1, total: 2 },
      handle: (cmd) => (cmd === "tagging_models" ? { ...choice, options: [choice.options[0], { ...choice.options[1], downloaded }] } : undefined),
    });
    render(<AutoTaggingSettings libraryId="L1" />);
    await screen.findByRole("option", { name: /CPU · .*需下载/ });
    downloaded = true;
    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "idle", model: "x", device: "cpu", gpu: null, tagged: 0 } }));
    expect(await screen.findByRole("option", { name: "CPU · 内存约 5.0 GB · 已下载" })).toBeTruthy();
  });

  it("从文件导入模型包，校验通过后显示已下载", async () => {
    window.__KINSHOKO_TEST_PICKS__ = ["D:\\离线\\pixai.zip"];
    const calls = backend({
      handle: (cmd) => (cmd === "tagging_import_package" ? { ...choice, options: [choice.options[0], { ...choice.options[1], downloaded: true }] } : undefined),
    });
    render(<AutoTaggingSettings libraryId="L1" />);
    fireEvent.click(await screen.findByRole("button", { name: "导入模型包…" }));
    expect(await screen.findByText("模型包已导入并通过校验")).toBeTruthy();
    expect(screen.getByRole("option", { name: "CPU · 内存约 5.0 GB · 已下载" })).toBeTruthy();
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
    render(<AutoTaggingSettings libraryId="L1" />);
    fireEvent.click(await screen.findByRole("button", { name: "导入模型包…" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("模型包校验失败：model.onnx 已损坏")).toBeTruthy();
  });
});
