import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { UpdateNotice, UpdateSection } from "./Update";
import { ToastProvider } from "./ui/Toast";

afterEach(() => {
  cleanup();
  clearMocks();
});

function backend(handle: (cmd: string) => unknown) {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return handle(cmd);
  }, { shouldMockEvents: true });
  return calls;
}

describe("主窗口的更新通知", () => {
  const notice = () => render(<ToastProvider><UpdateNotice /></ToastProvider>);

  it("还没检查过时检查一次，有新版本就在右下角通知，可以安装", async () => {
    const calls = backend((cmd) => {
      if (cmd === "update_status") return { state: "unchecked" };
      if (cmd === "check_update") return { state: "available", version: "0.2.0", notes: null };
      if (cmd === "install_update") return new Promise(() => {});
      return null;
    });
    notice();

    expect(await screen.findByText("Kinshoko 0.2.0 可以更新")).toBeTruthy();
    expect(screen.getByRole("region", { name: "提示" }).textContent).toContain("装好后自动重启");
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(calls).toContain("install_update"));
    expect(await screen.findByText("正在更新到 0.2.0")).toBeTruthy();

    await act(async () => { await emit("update-progress", { downloaded: 3 * 1024 * 1024, total: 12 * 1024 * 1024 }); });
    expect(await screen.findByText("正在下载 3.0／12.0 MB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装并重启" })).toBeNull();
  });

  it("安装失败时通知里说明原因，可以重试", async () => {
    let attempts = 0;
    backend((cmd) => {
      if (cmd === "update_status") return { state: "available", version: "0.2.0", notes: null };
      if (cmd === "install_update") {
        attempts += 1;
        return attempts === 1 ? Promise.reject("签名校验失败") : new Promise(() => {});
      }
      return null;
    });
    notice();

    fireEvent.click(await screen.findByRole("button", { name: "安装并重启" }));
    expect(await screen.findByText("更新失败")).toBeTruthy();
    expect(screen.getByText("签名校验失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByText("正在更新到 0.2.0")).toBeTruthy();
  });

  it("换了更新通道后收起通知：旧通道查到的更新已经作废", async () => {
    backend((cmd) =>
      cmd === "update_status" ? { state: "available", version: "1.0.0-beta.2", notes: null } : null,
    );
    notice();
    expect(await screen.findByText("Kinshoko 1.0.0-beta.2 可以更新")).toBeTruthy();

    await act(async () => { await emit("update-channel-changed"); });

    await waitFor(() => expect(screen.queryByText(/可以更新/)).toBeNull());
  });

  it("关掉通知就收起", async () => {
    backend((cmd) =>
      cmd === "update_status" ? { state: "available", version: "0.2.0", notes: null } : null,
    );
    notice();

    await screen.findByText("Kinshoko 0.2.0 可以更新");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示", hidden: true }));

    await waitFor(() => expect(screen.queryByText(/可以更新/)).toBeNull());
  });

  it("本次运行已经检查过或未启用更新时不再联网，也不通知", async () => {
    for (const state of ["upToDate", "disabled", "manual"]) {
      const calls = backend((cmd) => (cmd === "update_status" ? { state } : null));
      notice();
      await waitFor(() => expect(calls).toContain("update_status"));
      expect(calls).not.toContain("check_update");
      expect(screen.queryByText(/可以更新/)).toBeNull();
      cleanup();
    }
  });
});

describe("设置中的更新方式", () => {
  it("手动更新构建说明安装包步骤，并且没有自动检查和安装按钮", async () => {
    const calls = backend((cmd) => cmd === "update_status" ? {
      state: "manual", message: "当前使用安装包手动更新。",
    } : null);
    render(<UpdateSection />);

    fireEvent.click(await screen.findByRole("button", { name: "查看步骤" }));
    expect(await screen.findByText("当前使用安装包手动更新。")).toBeTruthy();
    expect(screen.getByText(/从托盘退出 Kinshoko/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "安装并重启" })).toBeNull();
    expect(calls).not.toContain("check_update");
  });
});

it("公开阶段未满足自动更新条件时显示原因且不提供操作", async () => {
  backend((cmd) => cmd === "update_status" ? {
    state: "disabled", message: "未配置原仓库的公开更新入口，自动更新未启用。请使用新版安装包手动更新。",
  } : null);
  render(<UpdateSection />);
  expect(await screen.findByText(/未配置原仓库的公开更新入口/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
});
