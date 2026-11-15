import { describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { UpdateNotice, UpdateSection } from "./Update";
import { fakeBackend, type FakeBackend } from "./test/backend";

/** 发出过的命令名，按先后。 */
const sent = (fake: FakeBackend) => fake.calls().map((call) => call.command);

describe("主窗口的更新通知", () => {
  const notice = () =>
    render(
      <>
        <UpdateNotice />
      </>,
    );

  it("还没检查过时检查一次，有新版本就在右下角通知，可以安装", async () => {
    const fake = fakeBackend({
      update_status: { state: "unchecked" },
      check_update: { state: "available", version: "0.2.0", notes: null },
      install_update: () => new Promise(() => {}),
    });
    notice();

    expect(await screen.findByText("Kinshoko 0.2.0 可以更新")).toBeTruthy();
    // 设计系统 v3：不写解释性描述，“安装并重启”已经说清楚了。
    expect(screen.getByRole("region", { name: "提示" }).textContent).not.toContain("装好后自动重启");
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(sent(fake)).toContain("install_update"));
    expect(await screen.findByText("正在更新到 0.2.0")).toBeTruthy();

    await act(async () => {
      await emit("update-progress", { downloaded: 3 * 1024 * 1024, total: 12 * 1024 * 1024 });
    });
    expect(await screen.findByText("正在下载 3 MB / 12 MB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装并重启" })).toBeNull();
  });

  it("安装失败时通知里说明原因，可以重试", async () => {
    let attempts = 0;
    fakeBackend({
      update_status: { state: "available", version: "0.2.0", notes: null },
      install_update: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject({ code: "message", message: "签名校验失败" }) : new Promise(() => {});
      },
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
    fakeBackend({ update_status: { state: "available", version: "1.0.0-beta.2", notes: null } });
    notice();
    expect(await screen.findByText("Kinshoko 1.0.0-beta.2 可以更新")).toBeTruthy();

    await act(async () => {
      await emit("update-channel-changed");
    });

    await waitFor(() => expect(screen.queryByText(/可以更新/)).toBeNull());
  });

  it("关掉通知就收起", async () => {
    fakeBackend({ update_status: { state: "available", version: "0.2.0", notes: null } });
    notice();

    await screen.findByText("Kinshoko 0.2.0 可以更新");
    fireEvent.click(screen.getByRole("button", { name: "关闭提示", hidden: true }));

    await waitFor(() => expect(screen.queryByText(/可以更新/)).toBeNull());
  });

  it("本次运行已经检查过或未启用更新时不再联网，也不通知", async () => {
    for (const state of ["upToDate", "disabled", "manual"]) {
      const fake = fakeBackend({ update_status: { state } });
      notice();
      await waitFor(() => expect(sent(fake)).toContain("update_status"));
      expect(sent(fake)).not.toContain("check_update");
      expect(screen.queryByText(/可以更新/)).toBeNull();
      cleanup();
    }
  });
});

describe("设置中的更新方式", () => {
  it("手动更新构建说明安装包步骤，并且没有自动检查和安装按钮", async () => {
    const fake = fakeBackend({ update_status: { state: "manual", message: { code: "updateManual" } } });
    render(<UpdateSection />);

    fireEvent.click(await screen.findByRole("button", { name: "查看步骤" }));
    expect(await screen.findByText("当前使用安装包手动更新。")).toBeTruthy();
    expect(screen.getByText(/从托盘退出 Kinshoko/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "安装并重启" })).toBeNull();
    expect(sent(fake)).not.toContain("check_update");
  });
});

it("公开阶段未满足自动更新条件时显示原因且不提供操作", async () => {
  fakeBackend({ update_status: { state: "disabled", message: { code: "updateNoEndpoint" } } });
  render(<UpdateSection />);
  expect(await screen.findByText(/未配置原仓库的公开更新入口/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
});
