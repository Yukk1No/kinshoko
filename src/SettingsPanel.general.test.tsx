import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SettingsPanel } from "./SettingsPanel";
import { backend, defaults, resetSettingsTest, tab } from "./SettingsPanel.fixtures";
import { chooseValue, optionNames } from "./test/select";

afterEach(resetSettingsTest);

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

    const select = await screen.findByRole("combobox", { name: "界面缩放" });
    expect(await optionNames(select)).toEqual(["80%", "90%", "100%", "110%", "125%", "150%", "175%", "200%"]);
    expect(select.dataset.value).toBe("100");
    await chooseValue(select, "150");
    expect(chosen).toEqual([150]);

    rerender(<SettingsPanel uiScale={150} onUiScale={(percent) => chosen.push(percent)} />);
    expect(screen.getByRole("combobox", { name: "界面缩放" }).dataset.value).toBe("150");
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
