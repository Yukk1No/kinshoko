import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogApproxEntry } from "./bindings/CatalogApproxEntry";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { TagLabel } from "./bindings/TagLabel";
import { SettingsPanel } from "./SettingsPanel";

afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  delete window.__KINSHOKO_TEST_PICKS__;
});

/** 切换到设置的某个分页。 */
async function tab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  await screen.findByRole("heading", { name, level: 3 });
}

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
  keepSelectionOnSafeMode: false,
  tagDisplay: { style: "bands", high: 0.8, low: 0.4, lowOutline: true },
  updateChannel: "stable",
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
  }, { shouldMockEvents: true });
  return calls;
}

describe("设置：读取", () => {
  it("读取中显示状态；读取失败显示原因与重试，重试成功后显示设置", async () => {
    let attempts = 0;
    let fail!: (reason: string) => void;
    mockIPC((cmd) => {
      if (cmd === "shell_settings") {
        attempts += 1;
        if (attempts === 1) return new Promise((_, reject) => { fail = reject; });
        return defaults;
      }
      return undefined;
    });
    render(<SettingsPanel />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "正在读取设置…");
    await act(async () => { fail("设置文件被占用"); });
    expect((await screen.findByRole("alert")).textContent).toContain("设置文件被占用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("switch", { name: "开机启动" })).toBeTruthy();
    expect(attempts).toBe(2);
  });
});

describe("设置：常驻与快捷键", () => {
  it("显示开机自启和每个动作的快捷键，没生效的键标出未注册及原因", async () => {
    backend(() => undefined);

    render(<SettingsPanel />);

    const autostart = await screen.findByRole("switch", { name: "开机启动" });
    expect(autostart.getAttribute("aria-checked")).toBe("true");
    await tab("快捷键");
    const capture = screen.getByRole("listitem", { name: "截图" });
    expect(within(capture).getByText("F1")).toBeTruthy();
    expect(within(capture).getByText("未注册：已被其他程序占用")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "钉剪贴板" })).getByText("F3")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "收起钉图" })).getByText("F4")).toBeTruthy();
    // 安全模式的按键固定，只说明不提供更换。
    expect(within(screen.getByRole("listitem", { name: "安全模式" })).queryByRole("button")).toBeNull();
  });

  it("关掉开机自启后显示核心保存的结果", async () => {
    const calls = backend((cmd) =>
      cmd === "set_autostart" ? { ...defaults, autostart: false } : undefined,
    );
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByRole("switch", { name: "开机启动" }));

    await screen.findByRole("switch", { name: "开机启动", checked: false });
    expect(calls.find((c) => c.cmd === "set_autostart")?.args).toEqual({ on: false });
  });

  it("快捷键页列出查看器的操作提示（#179，原在查看器的信息浮层里）", async () => {
    backend(() => undefined);
    render(<SettingsPanel initialTab="keys" />);
    const group = await screen.findByRole("list", { name: "查看器" });
    expect(within(within(group).getByRole("listitem", { name: "框选局部" })).getByText("拖动")).toBeTruthy();
    expect(within(group).getByRole("listitem", { name: "返回图片墙" }).textContent).toContain("Esc");
    expect(within(group).getByRole("listitem", { name: "显示或隐藏详情" }).textContent).toContain("I");
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
    render(<SettingsPanel initialTab="keys" />);
    const capture = await screen.findByRole("listitem", { name: "截图" });

    fireEvent.click(within(capture).getByRole("button", { name: "更换" }));
    const recorder = within(capture).getByRole("textbox", { name: "按下新的组合键" });
    expect(recorder.getAttribute("placeholder")).toBe("按下新的组合键…");
    fireEvent.keyDown(recorder, { key: "Control", code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(recorder, { key: "a", code: "KeyA", ctrlKey: true, altKey: true });

    expect(await within(capture).findByLabelText("Ctrl+Alt+A")).toBeTruthy();
    expect(within(capture).getByText("A")).toBeTruthy();
    expect(within(capture).queryByText(/未注册/)).toBeNull();
    expect(calls.find((c) => c.cmd === "rebind_shortcut")?.args).toEqual({
      action: "capture",
      accelerator: "Ctrl+Alt+KeyA",
    });
  });

  it("按 Esc 放弃更换，不发出命令", async () => {
    const calls = backend(() => undefined);
    const outer: string[] = [];
    render(<div onKeyDown={(e) => outer.push(e.key)}><SettingsPanel initialTab="keys" /></div>);
    const capture = await screen.findByRole("listitem", { name: "截图" });

    fireEvent.click(within(capture).getByRole("button", { name: "更换" }));
    fireEvent.keyDown(within(capture).getByRole("textbox"), { key: "Escape", code: "Escape" });
    // 录制中的 Esc 只取消录制，不会关掉外面的设置对话框。
    expect(outer).toEqual([]);

    expect(within(capture).getByText("F1")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "rebind_shortcut")).toBe(false);
  });

  it("更换被拒绝时显示原因，原来的键不变", async () => {
    backend((cmd) => {
      if (cmd === "rebind_shortcut") throw "这个快捷键已用于“钉剪贴板”";
      return undefined;
    });
    render(<SettingsPanel initialTab="keys" />);
    const hide = await screen.findByRole("listitem", { name: "收起钉图" });

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
    render(<SettingsPanel initialTab="keys" />);
    const pin = await screen.findByRole("listitem", { name: "钉剪贴板" });

    fireEvent.click(within(pin).getByRole("button", { name: "清除" }));

    expect(await within(pin).findByText("未设置")).toBeTruthy();
    expect(within(pin).getByRole("button", { name: "设置" })).toBeTruthy();
    expect(within(pin).queryByRole("button", { name: "清除" })).toBeNull();
    expect(calls.find((c) => c.cmd === "rebind_shortcut")?.args).toEqual({
      action: "pinClipboard",
      accelerator: null,
    });
  });
});

describe("设置：界面缩放", () => {
  it("通用分页的下拉框列出八个档位，跟随主窗口的档位，选中即交给主窗口", async () => {
    backend(() => undefined);
    const chosen: number[] = [];
    const { rerender } = render(<SettingsPanel uiScale={100} onUiScale={(percent) => chosen.push(percent)} />);

    const select = await screen.findByRole("combobox", { name: "界面缩放" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["80%", "90%", "100%", "110%", "125%", "150%", "175%", "200%"]);
    expect(select.value).toBe("100");
    fireEvent.change(select, { target: { value: "150" } });
    expect(chosen).toEqual([150]);

    rerender(<SettingsPanel uiScale={150} onUiScale={(percent) => chosen.push(percent)} />);
    expect((screen.getByRole("combobox", { name: "界面缩放" }) as HTMLSelectElement).value).toBe("150");
  });

  it("快捷键分页列出放大、缩小、复位三个固定按键，不能更换", async () => {
    backend(() => undefined);
    render(<SettingsPanel uiScale={100} onUiScale={() => {}} />);
    await tab("快捷键");

    for (const [name, keys] of [["放大界面", "Ctrl+="], ["缩小界面", "Ctrl+-"], ["界面复位到 100%", "Ctrl+0"]]) {
      const row = screen.getByRole("listitem", { name });
      expect(within(row).getByLabelText(keys)).toBeTruthy();
      expect(within(row).queryByRole("button")).toBeNull();
    }
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
    render(<SettingsPanel library={null} onChange={(v) => seen.push(v)} initialTab="tags" />);
    fireEvent.click(await screen.findByRole("button", { name: "相近" }));

    const toggle = await screen.findByRole("switch", { name: "标出来源" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await screen.findByRole("switch", { name: "标出来源", checked: true });
    expect(calls.find((c) => c.cmd === "set_show_approx_source")?.args).toEqual({ on: true });
    expect(seen.at(-1)?.showApproxSource).toBe(true);
  });

  it("切换安全模式时保留选择默认关闭，打开后告诉主窗口", async () => {
    const calls = backend((cmd) =>
      cmd === "set_keep_selection_on_safe_mode" ? { ...defaults, keepSelectionOnSafeMode: true } : undefined,
    );
    const seen: ShellSettingsView[] = [];
    render(<SettingsPanel library={null} onChange={(v) => seen.push(v)} initialTab="safety" safe onSafeMode={() => {}} />);

    const toggle = await screen.findByRole("switch", { name: "切换时保留选择" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await screen.findByRole("switch", { name: "切换时保留选择", checked: true });
    expect(calls.find((c) => c.cmd === "set_keep_selection_on_safe_mode")?.args).toEqual({ on: true });
    expect(seen.at(-1)?.keepSelectionOnSafeMode).toBe(true);
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
    render(<SettingsPanel library={library} initialTab="tags" />);
    fireEvent.click(await screen.findByRole("button", { name: "相近" }));

    const table = await screen.findByRole("table", { name: "相近标签表" });
    const rows = await within(table).findAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "蓝瞳～天空色相近删除",
      "蓝瞳～水色瞳不相近删除",
    ]);
    expect(within(rows[0]).getAllByRole("img", { name: "没有外部对应，不参与内置近似对应表" })).toHaveLength(1);

    fireEvent.click(within(rows[1]).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(within(screen.getByRole("table", { name: "相近标签表" })).getAllByRole("row")).toHaveLength(1));
    expect(calls.find((c) => c.cmd === "plugin:library|edit_shared_approx")?.args).toEqual({ edit: { kind: "remove", a: "B", b: "Q" }, safeMode: true });
  });
});

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

  it("使用日志默认关闭，可以打开、导出与清除", async () => {
    const calls = backend((cmd) => {
      if (cmd === "set_usage_log") return { ...defaults, usageLog: true };
      if (cmd === "export_usage_log") return true;
      if (cmd === "clear_usage_log") return null;
      return undefined;
    });
    render(<SettingsPanel initialTab="diag" />);

    const toggle = await screen.findByRole("switch", { name: "使用记录" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await screen.findByRole("switch", { name: "使用记录", checked: true });
    expect(calls.find((c) => c.cmd === "set_usage_log")?.args).toEqual({ on: true });

    fireEvent.click(screen.getByRole("button", { name: "导出记录…" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "export_usage_log")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "清除记录" }));
    await waitFor(() => expect(calls.some((c) => c.cmd === "clear_usage_log")).toBe(true));
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
    fireEvent.click(screen.getByRole("button", { name: "保存…" }));
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

it("refreshes personal approximate labels when shared display names change", async () => {
  let current = "旧显示名称";
  mockIPC((cmd) => cmd === "shell_settings" ? defaults : cmd.endsWith("safe_mode") ? true : cmd.endsWith("workspace_status") ? { revision: "r1", libraries: [] } : cmd.endsWith("shared_personal_approx") ? { revision: 1, conflicts: [], entries: [{ a: { id: "a", namespace: "general", name: current, untranslated: false, hasExternal: false }, b: { id: "b", namespace: "general", name: "另一个标签", untranslated: false, hasExternal: false }, relation: "similar", sources: [] }] } : undefined, { shouldMockEvents: true });
  render(<SettingsPanel library={{ id: "library", name: "资料库", root: "library" }} initialTab="tags" />);
  fireEvent.click(await screen.findByRole("button", { name: "相近" }));
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
    render(<SettingsPanel initialTab="backup" />);
    const file = await screen.findByRole("textbox", { name: "偏好设置备份文件" });
    fireEvent.change(file, { target: { value: "C:/backup/选择.kinshoko-settings" } });
    expect(screen.queryByRole("button", { name: "替换偏好设置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读取" }));
    const restore = await screen.findByRole("button", { name: "替换偏好设置" });
    expect(screen.getByText(/备份里没有的名称偏好和相近规则会删除/)).toBeTruthy();
    expect(calls.some((c) => c.cmd === "plugin:library|restore_application_settings")).toBe(false);
    fireEvent.click(restore);
    expect(await screen.findByText("偏好设置已恢复。按 sRGB 显示从托盘退出并重启后生效。")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "plugin:library|restore_application_settings")?.args).toEqual({ path: "C:/backup/选择.kinshoko-settings", fingerprint: "fixed-backup" });
  });
});

describe("设置：分页", () => {
  it("竖排八个分页，导航底部显示版本，切换后显示该页的说明", async () => {
    backend(() => undefined);
    render(<SettingsPanel version="Kinshoko 9.9.9" />);
    const tabs = await screen.findByRole("tablist", { name: "设置分页" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["通用", "快捷键", "标签", "自动标签", "备份", "安全", "更新", "诊断"]);
    expect(tabs.getAttribute("aria-orientation")).toBe("vertical");
    expect(screen.getByText("Kinshoko 9.9.9")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "通用", level: 3 })).toBeTruthy();
    await tab("安全");
    expect(screen.getByText("成人图收进封印书，需要时再打开。")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "开机启动" })).toBeNull();
  });

  it("自动打标与模型包移到自动标签分页，通用分页不再有", async () => {
    backend((cmd, args) => {
      if (cmd === "tagging_models") return { model: "PixAI Tagger v1.0", selected: null, options: [] };
      if (cmd === "tagging_status") return { libraryId: args.libraryId, status: { state: "paused" } };
      return undefined;
    });
    render(<SettingsPanel library={{ id: "L1", name: "资料库", root: "D:\\资料库" }} />);
    await screen.findByRole("switch", { name: "开机启动" });
    expect(screen.queryByText(/自动打标|模型包|硬件加速/)).toBeNull();

    await tab("自动标签");
    expect(await screen.findByRole("combobox", { name: "硬件加速" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入模型包…" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "继续" })).toBeTruthy();
  });

  it("可以直接打开自动标签分页", async () => {
    backend((cmd) => (cmd === "tagging_models" ? { model: "PixAI Tagger v1.0", selected: null, options: [] } : undefined));
    render(<SettingsPanel initialTab="tagging" />);
    expect(await screen.findByRole("heading", { name: "自动标签", level: 3 })).toBeTruthy();
    expect(await screen.findByText("添加图库后开始自动打标")).toBeTruthy();
  });

  it("安全分页的开关跟随并切换主窗口的安全模式", async () => {
    backend(() => undefined);
    let toggled = 0;
    const { rerender } = render(<SettingsPanel initialTab="safety" safe onSafeMode={() => { toggled++; }} />);
    const toggle = await screen.findByRole("switch", { name: "安全模式" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("Ctrl+Shift+S")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggled).toBe(1);
    rerender(<SettingsPanel initialTab="safety" safe={false} onSafeMode={() => { toggled++; }} />);
    expect(screen.getByRole("switch", { name: "安全模式" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("未开启")).toBeTruthy();
  });

  it("标签分页的旧名称提示打开确认向导", async () => {
    let opened = 0;
    backend((cmd) => cmd === "plugin:library|plan_legacy_names"
      ? { libraries: [], plan: { revision: 1, groups: [{ catalogId: "c", namespace: "general", lang: "zh-CN", defaultName: "蓝瞳", existingPreference: null, affectedLibraries: [], sources: [] }] } }
      : cmd === "plugin:library|inspect_tag_catalog" ? { libraries: [], catalog: { revision: 1, tags: [], mappings: [] } } : undefined);
    render(<SettingsPanel initialTab="tags" onOpenNameWizard={() => { opened++; }} />);
    expect(await screen.findByText("1 个旧名称待确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "逐个确认" }));
    expect(opened).toBe(1);
  });
});
