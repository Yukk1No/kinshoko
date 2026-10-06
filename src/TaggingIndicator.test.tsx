import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { TaggingStatus } from "./bindings/TaggingStatus";
import { TaggingIndicator } from "./TaggingIndicator";

let commands: string[];

function backend(status: TaggingStatus) {
  commands = [];
  mockWindows("main");
  mockIPC(
    (cmd) => {
      commands.push(cmd);
      if (cmd === "tagging_status") return status;
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
    render(<TaggingIndicator />);
    const button = await screen.findByRole("button", { name: /下载打标模型（993 MB）/ });
    expect(commands).not.toContain("tagging_download");
    fireEvent.click(button);
    await waitFor(() => expect(commands).toContain("tagging_download"));
  });

  it("上次下载中断时显示已下载的部分", async () => {
    backend({ state: "needsDownload", model: "PixAI", size: 1_000_000_000, downloaded: 250_000_000 });
    render(<TaggingIndicator />);
    expect(await screen.findByRole("button", { name: /继续下载打标模型（已下载 25%）/ })).toBeTruthy();
  });

  it("下载进度随推送更新", async () => {
    backend({ state: "starting" });
    render(<TaggingIndicator />);
    await waitFor(() => expect(commands).toContain("tagging_status"));
    await act(() =>
      emit("tagging-status", { state: "downloading", model: "PixAI", downloaded: 500_000_000, total: 1_000_000_000 }),
    );
    expect(await screen.findByText(/下载打标模型 50%（500 MB \/ 1000 MB）/)).toBeTruthy();
  });

  it("打标时可以暂停，暂停后可以继续", async () => {
    backend({ state: "running", model: "PixAI", device: "directMl", tagged: 3 });
    render(<TaggingIndicator />);
    expect(await screen.findByText(/自动标签：显卡，已打 3 张/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(commands).toContain("tagging_pause"));

    await act(() => emit("tagging-status", { state: "paused" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(commands).toContain("tagging_resume"));
  });
});
