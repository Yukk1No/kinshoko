import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { PersonalApproxEntry } from "./bindings/PersonalApproxEntry";
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
};

/** 记录前端发出的命令，按给定的处理函数回应。 */
function backend(handle: (cmd: string, args: Record<string, unknown>) => unknown) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    if (cmd === "shell_settings") return defaults;
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
  const entries: PersonalApproxEntry[] = [
    { a: label("B", "蓝瞳", true), b: label("S", "天空色", false), relation: "similar" },
    { a: label("B", "蓝瞳", true), b: label("Q", "水色瞳", true), relation: "notSimilar" },
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

  it("资料库设置中列出个人近似对应表的条目，可以删除", async () => {
    let listed = entries;
    const calls = backend((cmd, args) => {
      if (cmd === "plugin:library|personal_approx") return listed;
      if (cmd === "plugin:library|remove_tag_approx") {
        listed = listed.filter((e) => !(e.a.id === args.a && e.b.id === args.b));
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

    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(1));
    expect(calls.find((c) => c.cmd === "plugin:library|remove_tag_approx")?.args).toEqual({ a: "B", b: "Q" });
  });
});
