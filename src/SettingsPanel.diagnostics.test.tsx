import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";
import { backend, defaults, resetSettingsTest, tab } from "./SettingsPanel.fixtures";

afterEach(resetSettingsTest);

describe("设置：诊断", () => {
  it("打开强制 sRGB 后提示重启生效", async () => {
    const fake = backend({ set_force_srgb: { ...defaults, forceSrgb: true } });
    render(<SettingsPanel />);
    await tab("诊断");

    const toggle = await screen.findByRole("switch", { name: "按 sRGB 显示" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/重启 Kinshoko 后生效/)).toBeNull();
    fireEvent.click(toggle);

    await screen.findByRole("switch", { name: "按 sRGB 显示", checked: true });
    expect(fake.calls("set_force_srgb")[0]?.args).toEqual({ on: true });
    expect(screen.getByText(/重启 Kinshoko 后生效/)).toBeTruthy();
  });

  it("运行日志跟随保存的设置，可以关掉与清除", async () => {
    const fake = backend({
      set_run_log: { ...defaults, runLog: false },
      clear_run_log: null,
    });
    render(<SettingsPanel initialTab="diag" />);

    const toggle = await screen.findByRole("switch", { name: "运行日志", checked: true });
    expect(screen.queryByRole("switch", { name: "使用记录" })).toBeNull();
    fireEvent.click(toggle);
    await screen.findByRole("switch", { name: "运行日志", checked: false });
    expect(fake.calls("set_run_log")[0]?.args).toEqual({ on: false });

    fireEvent.click(screen.getByRole("button", { name: "清除日志" }));
    await waitFor(() => expect(fake.calls("clear_run_log").length > 0).toBe(true));
  });

  it("显示诊断信息并可以存成文件", async () => {
    const fake = backend({
      diagnostics_report: "Kinshoko 0.1.0 诊断信息\nWebView2：154.0",
      export_diagnostics: true,
    });
    render(<SettingsPanel initialTab="diag" />);

    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect((await screen.findByLabelText("诊断信息")).textContent).toContain("WebView2：154.0");
    fireEvent.click(screen.getByRole("button", { name: "存成文件…" }));
    await waitFor(() => expect(fake.calls("export_diagnostics").length > 0).toBe(true));
  });
});

describe("设置：更新", () => {
  it("没有配置更新公钥的构建说明不检查更新", async () => {
    backend({ update_status: { state: "disabled", message: { code: "updateNoPublicKey" } } });
    render(<SettingsPanel initialTab="update" />);

    expect(await screen.findByText(/未配置更新公钥/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("检查到新版本后可以安装", async () => {
    const fake = backend({
      update_status: { state: "unchecked" },
      check_update: { state: "available", version: "0.2.0", notes: "修正钉图" },
      install_update: null,
    });
    render(<SettingsPanel initialTab="update" version="Kinshoko 0.1.2" />);
    expect(await screen.findByText("Kinshoko 0.1.2", { selector: ".k-list-meta" })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("可以更新到 0.2.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(fake.calls("install_update").length > 0).toBe(true));
  });

  it("换到测试版通道后保存选择并按新通道重新检查", async () => {
    const fake = backend({
      update_status: { state: "upToDate" },
      set_update_channel: { ...defaults, updateChannel: "beta" },
      check_update: { state: "available", version: "1.0.0-beta.2", notes: null },
    });
    render(<SettingsPanel initialTab="update" />);

    const stable = await screen.findByRole("button", { name: "正式版" });
    expect(stable.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "测试版" }));

    expect(await screen.findByText("可以更新到 1.0.0-beta.2")).toBeTruthy();
    expect(fake.calls("set_update_channel")[0]?.args).toEqual({ channel: "beta" });
    const order = fake.calls().map((c) => c.command);
    expect(order.lastIndexOf("check_update")).toBeGreaterThan(order.indexOf("set_update_channel"));
    expect(screen.getByRole("button", { name: "测试版" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("保存通道失败时留在原来的通道，不重新检查", async () => {
    const fake = backend({
      update_status: { state: "upToDate" },
      set_update_channel: () => { throw { code: "message", message: "读写设置文件失败：磁盘已满" }; },
    });
    render(<SettingsPanel initialTab="update" />);

    fireEvent.click(await screen.findByRole("button", { name: "测试版" }));

    expect(await screen.findByText(/磁盘已满/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "正式版" }).getAttribute("aria-pressed")).toBe("true");
    expect(fake.calls().map((c) => c.command)).not.toContain("check_update");
  });

  it("手动更新与未启用自动更新的构建不显示更新通道", async () => {
    for (const status of [{ state: "manual", message: { code: "updateManual" } }, { state: "disabled", message: { code: "updateNoPublicKey" } }]) {
      backend({ update_status: status });
      render(<SettingsPanel initialTab="update" />);
      expect(await screen.findByText(status.state === "manual" ? "手动更新" : "自动更新")).toBeTruthy();
      expect(screen.queryByRole("group", { name: "更新通道" })).toBeNull();
      cleanup();
    }
  });
});
