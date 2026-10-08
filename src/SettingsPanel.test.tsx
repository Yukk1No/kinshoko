import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogApproxEntry } from "./bindings/CatalogApproxEntry";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { TagLabel } from "./bindings/TagLabel";
import { SettingsPanel } from "./SettingsPanel";

afterEach(() => {
  cleanup();
  clearMocks();
});

const defaults: ShellSettingsView = {
  autostart: true,
  shortcuts: [
    { action: "capture", accelerator: "F1", problem: "已被其他程序占用" },
    { action: "pinClipboard", accelerator: "F3", problem: null },
    { action: "hideAllPins", accelerator: "F4", problem: null },
  ],
  showApproxSource: false,
  forceSrgb: false,
  forceSrgbInEffect: false,
  usageLog: false,
};

/** 记录前端发出的命令，按给定的处理函数回应。 */
function backend(handle: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "shell_settings") return defaults;
    if (cmd === "plugin:library|safe_mode") return true;
    if (cmd === "plugin:library|workspace_status") return { revision: "r1", libraries: [] };
    return handle(cmd, a);
  });
  return calls;
}

describe("设置：常驻与快捷键", () => {
  it("显示开机自启和每个动作的快捷键，没生效的键标出未注册及原因", async () => {
    backend(() => undefined);

    render(<SettingsPanel />);

    const autostart = await screen.findByRole("checkbox", { name: "开机时启动 Kinshoko" });
    expect((autostart as HTMLInputElement).checked).toBe(true);
    const capture = screen.getByRole("row", { name: /截图/ });
    expect(within(capture).getByText("F1")).toBeTruthy();
    expect(within(capture).getByText("未注册：已被其他程序占用")).toBeTruthy();
    expect(within(screen.getByRole("row", { name: /钉剪贴板/ })).getByText("F3")).toBeTruthy();
    expect(within(screen.getByRole("row", { name: /收起全部钉图/ })).getByText("F4")).toBeTruthy();
  });

  it("关掉开机自启后显示核心保存的结果", async () => {
    const calls = backend((cmd) =>
      cmd === "set_autostart" ? { ...defaults, autostart: false } : undefined,
    );
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "开机时启动 Kinshoko" }));

    await screen.findByRole("checkbox", { name: "开机时启动 Kinshoko", checked: false });
    expect(calls.find((c) => c.cmd === "set_autostart")?.args).toEqual({ on: false });
  });

  it("按下新的组合键即更换快捷键", async () => {
    const calls = backend((cmd) =>
      cmd === "rebind_shortcut"
        ? {
            ...defaults,
            shortcuts: [
              { action: "capture", accelerator: "Ctrl+Alt+A", problem: null },
              ...defaults.shortcuts.slice(1),
            ],
          }
        : undefined,
    );
    render(<SettingsPanel />);
    const capture = await screen.findByRole("row", { name: /截图/ });

    fireEvent.click(within(capture).getByRole("button", { name: "更换" }));
    const recorder = within(capture).getByRole("textbox", { name: "按下新的快捷键" });
    fireEvent.keyDown(recorder, { key: "Control", code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(recorder, { key: "a", code: "KeyA", ctrlKey: true, altKey: true });

    expect(await within(capture).findByText("Ctrl+Alt+A")).toBeTruthy();
    expect(within(capture).queryByText(/未注册/)).toBeNull();
    expect(calls.find((c) => c.cmd === "rebind_shortcut")?.args).toEqual({
      action: "capture",
      accelerator: "Ctrl+Alt+KeyA",
    });
  });

  it("按 Esc 放弃更换，不发出命令", async () => {
    const calls = backend(() => undefined);
    render(<SettingsPanel />);
    const capture = await screen.findByRole("row", { name: /截图/ });

    fireEvent.click(within(capture).getByRole("button", { name: "更换" }));
    fireEvent.keyDown(within(capture).getByRole("textbox"), { key: "Escape", code: "Escape" });

    expect(within(capture).getByText("F1")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "rebind_shortcut")).toBe(false);
  });

  it("更换被拒绝时显示原因，原来的键不变", async () => {
    backend((cmd) => {
      if (cmd === "rebind_shortcut") throw "这个快捷键已用于“钉剪贴板”";
      return undefined;
    });
    render(<SettingsPanel />);
    const hide = await screen.findByRole("row", { name: /收起全部钉图/ });

    fireEvent.click(within(hide).getByRole("button", { name: "更换" }));
    fireEvent.keyDown(within(hide).getByRole("textbox"), { key: "F3", code: "F3" });

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "这个快捷键已用于“钉剪贴板”",
    );
    expect(within(hide).getByText("F4")).toBeTruthy();
  });

  it("清除快捷键", async () => {
    const calls = backend((cmd) =>
      cmd === "rebind_shortcut"
        ? {
            ...defaults,
            shortcuts: [
              defaults.shortcuts[0],
              { action: "pinClipboard", accelerator: null, problem: null },
              defaults.shortcuts[2],
            ],
          }
        : undefined,
    );
    render(<SettingsPanel />);
    const pin = await screen.findByRole("row", { name: /钉剪贴板/ });

    fireEvent.click(within(pin).getByRole("button", { name: "清除" }));

    expect(await within(pin).findByText("未设置")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "rebind_shortcut")?.args).toEqual({
      action: "pinClipboard",
      accelerator: null,
    });
  });
});

describe("设置：近似查找", () => {
  const library = { id: "L1", name: "工作参考", root: "D:\\参考" };
  const label = (id: string, name: string, hasExternal: boolean): TagLabel => ({
    id,
    namespace: "general",
    name,
    untranslated: false,
    hasExternal,
  });
  const entries: CatalogApproxEntry[] = [
    { a: label("B", "蓝瞳", true), b: label("S", "天空色", false), relation: "similar", sources: [] },
    { a: label("B", "蓝瞳", true), b: label("Q", "水色瞳", true), relation: "notSimilar", sources: [] },
  ];

  it("相近标签来源标记默认关闭，打开后告诉主窗口", async () => {
    const calls = backend((cmd) =>
      cmd === "set_show_approx_source" ? { ...defaults, showApproxSource: true } : undefined,
    );
    const seen: ShellSettingsView[] = [];
    render(<SettingsPanel library={null} onChange={(v) => seen.push(v)} />);

    const toggle = await screen.findByRole("checkbox", { name: "显示相近标签来源（内置／个人）" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);

    await screen.findByRole("checkbox", { name: "显示相近标签来源（内置／个人）", checked: true });
    expect(calls.find((c) => c.cmd === "set_show_approx_source")?.args).toEqual({ on: true });
    expect(seen.at(-1)?.showApproxSource).toBe(true);
  });

  it("程序设置中列出全局个人近似对应表，可以删除", async () => {
    let listed = entries;
    const calls = backend((cmd, args) => {
      if (cmd === "plugin:library|shared_personal_approx") return { revision: 1, entries: listed, conflicts: [] };
      if (cmd === "plugin:library|edit_shared_approx") {
        const edit = args.edit as { a: string; b: string };
        listed = listed.filter((e) => !(e.a.id === edit.a && e.b.id === edit.b));
        return null;
      }
      return undefined;
    });
    render(<SettingsPanel library={library} />);

    const table = await screen.findByRole("table", { name: "个人近似对应表" });
    const rows = await within(table).findAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "蓝瞳～天空色相近删除",
      "蓝瞳～水色瞳不相近删除",
    ]);
    expect(within(rows[0]).getAllByRole("img", { name: "没有外部对应，不参与内置近似对应表" })).toHaveLength(1);

    fireEvent.click(within(rows[1]).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(within(screen.getByRole("table", { name: "个人近似对应表" })).getAllByRole("row")).toHaveLength(1));
    expect(calls.find((c) => c.cmd === "plugin:library|edit_shared_approx")?.args).toEqual({ edit: { kind: "remove", a: "B", b: "Q" }, safeMode: true });
  });
});

describe("设置：诊断", () => {
  it("打开强制 sRGB 后提示重启生效", async () => {
    const calls = backend((cmd) =>
      cmd === "set_force_srgb" ? { ...defaults, forceSrgb: true } : undefined,
    );
    render(<SettingsPanel />);

    const toggle = await screen.findByRole("checkbox", { name: "强制 sRGB（诊断用）" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/重启 Kinshoko 后生效/)).toBeNull();
    fireEvent.click(toggle);

    await screen.findByRole("checkbox", { name: "强制 sRGB（诊断用）", checked: true });
    expect(calls.find((c) => c.cmd === "set_force_srgb")?.args).toEqual({ on: true });
    expect(screen.getByText(/重启 Kinshoko 后生效/)).toBeTruthy();
  });

  it("使用日志默认关闭，可以打开、导出与清除", async () => {
    const calls = backend((cmd) => {
      if (cmd === "set_usage_log") return { ...defaults, usageLog: true };
      if (cmd === "export_usage_log") return true;
      if (cmd === "clear_usage_log") return null;
      return undefined;
    });
    render(<SettingsPanel />);

    const toggle = await screen.findByRole("checkbox", { name: "记录使用日志（只存在本机）" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await screen.findByRole("checkbox", { name: "记录使用日志（只存在本机）", checked: true });
    expect(calls.find((c) => c.cmd === "set_usage_log")?.args).toEqual({ on: true });

    fireEvent.click(screen.getByRole("button", { name: "导出使用日志…" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "export_usage_log")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "清除使用日志" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "clear_usage_log")).toBe(true));
  });

  it("显示诊断信息并可以存成文件", async () => {
    const calls = backend((cmd) => {
      if (cmd === "diagnostics_report") return "Kinshoko 0.1.0 诊断信息\nWebView2：154.0";
      if (cmd === "export_diagnostics") return true;
      return undefined;
    });
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "显示诊断信息" }));

    expect((await screen.findByLabelText("诊断信息")).textContent).toContain("WebView2：154.0");
    fireEvent.click(screen.getByRole("button", { name: "存成文件…" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "export_diagnostics")).toBe(true));
  });
});

describe("设置：更新", () => {
  it("没有配置更新公钥的构建说明不检查更新", async () => {
    backend((cmd) => (cmd === "update_status" ? { state: "disabled", message: "未配置更新公钥，自动更新未启用。请使用新版安装包手动更新。" } : undefined));
    render(<SettingsPanel />);

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
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("可以更新到 0.2.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "install_update")).toBe(true));
  });
});

it("refreshes personal approximate labels when shared display names change", async () => {
  let current = "旧显示名称";
  mockIPC((cmd) => cmd === "shell_settings" ? defaults : cmd.endsWith("safe_mode") ? true : cmd.endsWith("workspace_status") ? { revision: "r1", libraries: [] } : cmd.endsWith("shared_personal_approx") ? { revision: 1, conflicts: [], entries: [{ a: { id: "a", namespace: "general", name: current, untranslated: false, hasExternal: false }, b: { id: "b", namespace: "general", name: "另一个标签", untranslated: false, hasExternal: false }, relation: "similar", sources: [] }] } : undefined, { shouldMockEvents: true });
  render(<SettingsPanel library={{ id: "library", name: "资料库", root: "library" }} />);
  await screen.findByText(/旧显示名称/);
  current = "新的共享名称";
  await act(async () => { await emit("workspace-changed", { revision: "r2", libraries: [] }); });
  await screen.findByText(/新的共享名称/);
});


describe("程序设置备份", () => {
  it("只在读取兼容备份并确认替换范围后恢复，显示重启条件", async () => {
    const calls = backend((cmd) => {
      if (cmd === "plugin:library|preview_application_settings") return { fingerprint: "fixed-backup", safeMode: true, forceSrgb: true };
      if (cmd === "plugin:library|restore_application_settings") return { settings: { ...defaults, forceSrgb: true, forceSrgbInEffect: false, showApproxSource: true }, safeMode: true, problems: [] };
      return undefined;
    });
    render(<SettingsPanel />);
    const file = await screen.findByRole("textbox", { name: "程序设置备份文件" });
    fireEvent.change(file, { target: { value: "C:/backup/选择.kinshoko-settings" } });
    expect(screen.queryByRole("button", { name: "替换程序设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读取程序设置备份" }));
    const restore = await screen.findByRole("button", { name: "替换程序设置" });
    expect(screen.getByText(/缺席的名称偏好和个人规则会删除/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "plugin:library|restore_application_settings")).toBe(false);
    fireEvent.click(restore);
    expect(await screen.findByText("程序设置恢复完成。强制 sRGB 从托盘退出并重启后生效。")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "plugin:library|restore_application_settings")?.args).toEqual({ path: "C:/backup/选择.kinshoko-settings", fingerprint: "fixed-backup" });
  });
});
