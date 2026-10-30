import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { CatalogApproxEntry } from "./bindings/CatalogApproxEntry";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { TagLabel } from "./bindings/TagLabel";
import { SettingsPanel } from "./SettingsPanel";
import { createShellSettings } from "./shell/useShellSettings";
import { backend, defaults, resetSettingsTest, tab } from "./SettingsPanel.fixtures";

afterEach(resetSettingsTest);

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

  it("增强钉图边缘默认关闭，打开后保存（#239）", async () => {
    const calls = backend((cmd) =>
      cmd === "set_pin_edge_contrast" ? { ...defaults, pinEdgeContrast: true } : undefined,
    );
    render(<SettingsPanel library={null} initialTab="general" />);

    const toggle = await screen.findByRole("switch", { name: "增强钉图边缘" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);

    await screen.findByRole("switch", { name: "增强钉图边缘", checked: true });
    expect(calls.find((c) => c.cmd === "set_pin_edge_contrast")?.args).toEqual({ on: true });
  });

  it("安全模式范围默认敏感及以上，改选后保存并告诉主窗口", async () => {
    const calls = backend((cmd) =>
      cmd === "plugin:library|set_safe_mode_scope" ? { ...defaults, safeModeScope: "explicit" } : undefined,
    );
    const seen: ShellSettingsView[] = [];
    render(<SettingsPanel library={null} onChange={(v) => seen.push(v)} initialTab="safety" safe onSafeMode={() => {}} />);

    const scope = await screen.findByRole("group", { name: "安全模式范围" });
    expect(within(scope).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["轻度及以上", "false"], ["敏感及以上", "true"], ["仅成人", "false"],
    ]);
    fireEvent.click(within(scope).getByRole("button", { name: "仅成人" }));

    await waitFor(() => expect(within(scope).getByRole("button", { name: "仅成人" }).getAttribute("aria-pressed")).toBe("true"));
    expect(calls.find((c) => c.cmd === "plugin:library|set_safe_mode_scope")?.args).toEqual({ scope: "explicit" });
    expect(seen.at(-1)?.safeModeScope).toBe("explicit");
  });

  it("关掉再打开设置时共用主窗口的提交队列，先选的范围不会在后选的之后写入（#321）", async () => {
    const waiting: (() => void)[] = [];
    const calls = backend((cmd, args) => {
      if (cmd !== "plugin:library|set_safe_mode_scope") return undefined;
      const reply = { ...defaults, safeModeScope: args.scope as ShellSettingsView["safeModeScope"] };
      return new Promise((resolve) => waiting.push(() => resolve(reply)));
    });
    const seen: ShellSettingsView[] = [];
    const settings = createShellSettings((view) => seen.push(view));
    const first = render(<SettingsPanel library={null} settings={settings} initialTab="safety" safe onSafeMode={() => {}} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "安全模式范围" })).getByRole("button", { name: "仅成人" }));
    first.unmount();
    render(<SettingsPanel library={null} settings={settings} initialTab="safety" safe onSafeMode={() => {}} />);
    fireEvent.click(within(await screen.findByRole("group", { name: "安全模式范围" })).getByRole("button", { name: "轻度及以上" }));
    const scopes = () => calls.filter((c) => c.cmd === "plugin:library|set_safe_mode_scope").map((c) => c.args.scope);
    await waitFor(() => expect(waiting.length).toBe(1));
    expect(scopes()).toEqual(["explicit"]);
    waiting.shift()!();
    await waitFor(() => expect(scopes()).toEqual(["explicit", "sensitive"]));
    waiting.shift()!();
    await waitFor(() => expect(seen.map((view) => view.safeModeScope)).toEqual(["explicit", "sensitive"]));
    expect(within(screen.getByRole("group", { name: "安全模式范围" })).getByRole("button", { name: "轻度及以上" }).getAttribute("aria-pressed")).toBe("true");
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

  it("恢复排在还没回来的保存之后，迟到的保存不回滚恢复的结果（#321）", async () => {
    let releaseAutostart = () => {};
    const restoredView: ShellSettingsView = { ...defaults, autostart: true, showApproxSource: true };
    const calls = backend((cmd) => {
      if (cmd === "set_autostart") return new Promise((resolve) => { releaseAutostart = () => resolve({ ...defaults, autostart: false }); });
      if (cmd === "plugin:library|preview_application_settings") return { fingerprint: "fixed-backup", safeMode: true, forceSrgb: false };
      if (cmd === "plugin:library|restore_application_settings") return { settings: restoredView, safeMode: true, problems: [] };
      return undefined;
    });
    const seen: ShellSettingsView[] = [];
    render(<SettingsPanel initialTab="general" onChange={(view) => seen.push(view)} />);
    fireEvent.click(await screen.findByRole("switch", { name: "开机启动" }));
    await tab("备份");
    fireEvent.change(await screen.findByRole("textbox", { name: "偏好设置备份文件" }), { target: { value: "C:/backup/a.kinshoko-settings" } });
    fireEvent.click(screen.getByRole("button", { name: "读取" }));
    fireEvent.click(await screen.findByRole("button", { name: "替换偏好设置" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((c) => c.cmd === "plugin:library|restore_application_settings")).toBe(false);
    releaseAutostart();
    expect(await screen.findByText(/偏好设置已恢复/)).toBeTruthy();
    expect(seen.map((view) => view.autostart)).toEqual([false, true]);
    await tab("通用");
    expect(screen.getByRole("switch", { name: "开机启动" }).getAttribute("aria-checked")).toBe("true");
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
    expect(screen.getByRole("heading", { name: "安全", level: 3 })).toBeTruthy();
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
    expect(await screen.findByText("添加图库后开始")).toBeTruthy();
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
