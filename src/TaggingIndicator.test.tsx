import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { TaggingIndicator } from "./TaggingIndicator";

let commands: string[];
let actions: { command: string; libraryId: unknown }[];

function backend(status: TaggingStatus) {
  commands = [];
  actions = [];
  mockWindows("main");
  mockIPC(
    (cmd, args) => {
      commands.push(cmd);
      actions.push({ command: cmd, libraryId: args && "libraryId" in args ? args.libraryId : undefined });
      if (cmd === "tagging_status") return { libraryId: "L1", status };
      return null;
    },
    { shouldMockEvents: true },
  );
}

beforeEach(() => {
  commands = [];
});

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("自动标签状态", () => {
  it("首次使用时显示模型大小，确认后才下载", async () => {
    backend({ state: "needsDownload", model: "PixAI", size: 992_916_002, downloaded: 0 });
    render(<TaggingIndicator libraryId="L1" />);
    const button = await screen.findByRole("button", { name: /下载打标模型（993 MB）/ });
    expect(commands).not.toContain("tagging_download");
    fireEvent.click(button);
    await waitFor(() => expect(commands).toContain("tagging_download"));
    expect(actions).toContainEqual({ command: "tagging_download", libraryId: "L1" });
  });

  it("上次下载中断时显示已下载的部分", async () => {
    backend({ state: "needsDownload", model: "PixAI", size: 1_000_000_000, downloaded: 250_000_000 });
    render(<TaggingIndicator libraryId="L1" />);
    expect(await screen.findByRole("button", { name: /继续下载打标模型（已下载 25%）/ })).toBeTruthy();
  });

  it("下载进度随推送更新", async () => {
    backend({ state: "starting" });
    render(<TaggingIndicator libraryId="L1" />);
    await waitFor(() => expect(commands).toContain("tagging_status"));
    await act(() =>
      emit("tagging-status", { libraryId: "L1", status: { state: "downloading", model: "PixAI", downloaded: 500_000_000, total: 1_000_000_000 } }),
    );
    expect(await screen.findByText(/下载打标模型 50%（500 MB \/ 1000 MB）/)).toBeTruthy();
  });

  it("打标时可以暂停，暂停后可以继续", async () => {
    backend({ state: "running", model: "PixAI", device: "directMl", tagged: 3 });
    render(<TaggingIndicator libraryId="L1" />);
    expect(await screen.findByText(/自动标签：显卡，已打 3 张/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(commands).toContain("tagging_pause"));

    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "paused" } }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(commands).toContain("tagging_resume"));
    expect(actions).toContainEqual({ command: "tagging_pause", libraryId: "L1" });
    expect(actions).toContainEqual({ command: "tagging_resume", libraryId: "L1" });
  });

  // #77 UI-C：加载模型可能要几分钟（子进程已占显存），开始与校验阶段也要能暂停。
  it.each<[string, TaggingStatus, RegExp]>([
    ["开始（加载模型）", { state: "starting" }, /自动标签：正在加载打标模型/],
    ["校验模型", { state: "preparing", model: "PixAI" }, /正在校验打标模型/],
  ])("%s时可以暂停，迟到的就绪不再显示打标，之后可以继续", async (_, loading, text) => {
    backend(loading);
    render(<TaggingIndicator libraryId="L1" />);
    expect(await screen.findByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(actions).toContainEqual({ command: "tagging_pause", libraryId: "L1" }));

    // 调度结束了加载中的子进程，进入暂停；之后不会再推送 Running（迟到的 Ready 被丢弃，见核心测试）。
    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "paused" } }));
    expect(screen.queryByRole("button", { name: "暂停" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(actions).toContainEqual({ command: "tagging_resume", libraryId: "L1" }));

    await act(() => emit("tagging-status", { libraryId: "L1", status: { state: "starting" } }));
    expect(await screen.findByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("另一个资料库的迟到状态不能覆盖当前状态", async () => {
    backend({ state: "paused" });
    render(<TaggingIndicator libraryId="L1" />);
    await screen.findByText(/自动标签已暂停/);

    await act(() => emit("tagging-status", { libraryId: "L2", status: { state: "failed", reason: "旧库打标失败" } }));

    expect(screen.queryByText(/旧库打标失败/)).toBeNull();
    expect(screen.getByText(/自动标签已暂停/)).toBeTruthy();
  });
});
