import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";
import { backend, defaults, resetSettingsTest, tab } from "./SettingsPanel.fixtures";

afterEach(resetSettingsTest);

describe("设置：诊断", () => {
  it("打开强制 sRGB 后提示重启生效", async () => {
    const calls = backend((cmd) =>
      cmd === "set_force_srgb" ? { ...defaults, forceSrgb: true } : undefined,
    );
    render(<SettingsPanel />);
    await tab("诊断");

    const toggle = await screen.findByRole("switch", { name: "按 sRGB 显示" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/重启 Kinshoko 后生效/)).toBeNull();
    fireEvent.click(toggle);

    await screen.findByRole("switch", { name: "按 sRGB 显示", checked: true });
    expect(calls.find((c) => c.cmd === "set_force_srgb")?.args).toEqual({ on: true });
    expect(screen.getByText(/重启 Kinshoko 后生效/)).toBeTruthy();
  });

  it("运行日志跟随保存的设置，可以关掉与清除，说明不记文件名与图片", async () => {
    const calls = backend((cmd) => {
      if (cmd === "set_run_log") return { ...defaults, runLog: false };
      if (cmd === "clear_run_log") return null;
      return undefined;
    });
    render(<SettingsPanel initialTab="diag" />);

    const toggle = await screen.findByRole("switch", { name: "运行日志", checked: true });
    expect(screen.getByText(/不记文件名、路径、标签与图片/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "使用记录" })).toBeNull();
    fireEvent.click(toggle);
    await screen.findByRole("switch", { name: "运行日志", checked: false });
    expect(calls.find((c) => c.cmd === "set_run_log")?.args).toEqual({ on: false });

    fireEvent.click(screen.getByRole("button", { name: "清除日志" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "clear_run_log")).toBe(true));
  });

  it("显示诊断信息并可以存成文件", async () => {
    const calls = backend((cmd) => {
      if (cmd === "diagnostics_report") return "Kinshoko 0.1.0 诊断信息\nWebView2：154.0";
      if (cmd === "export_diagnostics") return true;
      return undefined;
    });
    render(<SettingsPanel initialTab="diag" />);

    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findByLabelText("诊断信息")).textContent).toContain("WebView2：154.0");
    expect(screen.getByText(/附上最近 7 天的运行日志/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "存成文件…" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "export_diagnostics")).toBe(true));
  });
});

describe("设置：更新", () => {
  it("没有配置更新公钥的构建说明不检查更新", async () => {
    backend((cmd) => (cmd === "update_status" ? { state: "disabled", message: "未配置更新公钥，自动更新未启用。请使用新版安装包手动更新。" } : undefined));
    render(<SettingsPanel initialTab="update" />);

    expect(await screen.findByText(/未配置更新公钥/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("检查到新版本后可以安装", async () => {
    const calls = backend((cmd) => {
      if (cmd === "update_status") return { state: "unchecked" };
      if (cmd === "check_update") return { state: "available", version: "0.2.0", notes: "修正钉图" };
      if (cmd === "install_update") return null;
      return undefined;
    });
    render(<SettingsPanel initialTab="update" version="Kinshoko 0.1.2" />);
    expect(await screen.findByText("Kinshoko 0.1.2", { selector: ".k-list-desc" })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("可以更新到 0.2.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "install_update")).toBe(true));
  });

  it("换到测试版通道后保存选择并按新通道重新检查", async () => {
    const calls = backend((cmd) => {
      if (cmd === "update_status") return { state: "upToDate" };
      if (cmd === "set_update_channel") return { ...defaults, updateChannel: "beta" };
      if (cmd === "check_update") return { state: "available", version: "1.0.0-beta.2", notes: null };
      return undefined;
    });
    render(<SettingsPanel initialTab="update" />);

    const stable = await screen.findByRole("button", { name: "正式版" });
    expect(stable.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "测试版" }));

    expect(await screen.findByText("可以更新到 1.0.0-beta.2")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "set_update_channel")?.args).toEqual({ channel: "beta" });
    const order = calls.map((c) => c.cmd);
    expect(order.lastIndexOf("check_update")).toBeGreaterThan(order.indexOf("set_update_channel"));
    expect(screen.getByRole("button", { name: "测试版" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("保存通道失败时留在原来的通道，不重新检查", async () => {
    const calls = backend((cmd) => {
      if (cmd === "update_status") return { state: "upToDate" };
      if (cmd === "set_update_channel") throw "读写设置文件失败：磁盘已满";
      return undefined;
    });
    render(<SettingsPanel initialTab="update" />);

    fireEvent.click(await screen.findByRole("button", { name: "测试版" }));

    expect(await screen.findByText(/磁盘已满/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "正式版" }).getAttribute("aria-pressed")).toBe("true");
    expect(calls.map((c) => c.cmd)).not.toContain("check_update");
  });

  it("手动更新与未启用自动更新的构建不显示更新通道", async () => {
    for (const status of [{ state: "manual", message: "当前使用安装包手动更新。" }, { state: "disabled", message: "未配置更新公钥，自动更新未启用。" }]) {
      backend((cmd) => (cmd === "update_status" ? status : undefined));
      render(<SettingsPanel initialTab="update" />);
      expect(await screen.findByText(status.state === "manual" ? "手动更新" : "自动更新")).toBeTruthy();
      expect(screen.queryByRole("group", { name: "更新通道" })).toBeNull();
      cleanup();
    }
  });
});
