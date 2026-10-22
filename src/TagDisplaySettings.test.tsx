// 设置 › 标签 › 外观（#160）：标签风格 B / C、可信度分档阈值、低档虚线框；本设备设置，改了立即告诉主窗口。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import type { TagDisplay } from "./bindings/TagDisplay";
import { SettingsPanel } from "./SettingsPanel";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

/** 像核心一样保存标签外观：阈值交叉时拒绝，原来的设置不变。 */
function backend() {
  let saved: TagDisplay = { style: "bands", high: 0.8, low: 0.4, lowOutline: true };
  const sent: TagDisplay[] = [];
  const view = (): ShellSettingsView => ({
    autostart: true, shortcuts: [], showApproxSource: false, forceSrgb: false, forceSrgbInEffect: false,
    runLog: false, keepSelectionOnSafeMode: false, pinEdgeContrast: false, safeModeScope: "questionable", updateChannel: "stable", tagDisplay: saved,
  });
  mockIPC((cmd, args) => {
    if (cmd === "shell_settings") return view();
    if (cmd === "set_tag_display") {
      const display = (args as { display: TagDisplay }).display;
      sent.push(display);
      if (display.low >= display.high) throw "低档上限要小于高档下限，且都在 0 到 1 之间";
      saved = display;
      return view();
    }
    if (cmd === "plugin:library|safe_mode") return true;
    return undefined;
  }, { shouldMockEvents: true });
  return { sent, saved: () => saved };
}

async function openAppearance(onChange?: (view: ShellSettingsView) => void) {
  render(<SettingsPanel library={null} initialTab="tags" onChange={onChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "外观" }));
  return {
    high: await screen.findByRole("spinbutton", { name: "高档下限" }) as HTMLInputElement,
    low: screen.getByRole("spinbutton", { name: "低档上限" }) as HTMLInputElement,
    outline: screen.getByRole("switch", { name: "低档虚线框" }),
  };
}

describe("设置：标签外观", () => {
  it("默认：按可信度分档，高档下限 0.80、低档上限 0.40，步长 0.05，低档虚线框开", async () => {
    backend();
    const { high, low, outline } = await openAppearance();
    expect(screen.getByRole("button", { name: "按可信度分档" }).getAttribute("aria-pressed")).toBe("true");
    expect(high.value).toBe("0.80");
    expect(low.value).toBe("0.40");
    expect(high.step).toBe("0.05");
    expect(low.step).toBe("0.05");
    expect(outline.getAttribute("aria-checked")).toBe("true");
  });

  it("切到按出处分组、改阈值、关虚线框，都立即保存并告诉主窗口", async () => {
    const store = backend();
    const seen: ShellSettingsView[] = [];
    const { high, outline } = await openAppearance((view) => seen.push(view));
    fireEvent.click(screen.getByRole("button", { name: "按出处分组" }));
    await waitFor(() => expect(seen.at(-1)?.tagDisplay.style).toBe("grouped"));
    fireEvent.change(high, { target: { value: "0.75" } });
    await waitFor(() => expect(seen.at(-1)?.tagDisplay.high).toBe(0.75));
    fireEvent.click(outline);
    await waitFor(() => expect(seen.at(-1)?.tagDisplay.lowOutline).toBe(false));
    expect(store.saved()).toEqual({ style: "grouped", high: 0.75, low: 0.4, lowOutline: false });
  });

  it("前一次保存还没回来时连着改几项，后改的不被先回来的结果盖掉", async () => {
    let saved: TagDisplay = { style: "bands", high: 0.8, low: 0.4, lowOutline: true };
    const waiting: (() => void)[] = [];
    const view = (tagDisplay: TagDisplay): ShellSettingsView => ({
      autostart: true, shortcuts: [], showApproxSource: false, forceSrgb: false, forceSrgbInEffect: false,
      runLog: false, keepSelectionOnSafeMode: false, pinEdgeContrast: false, safeModeScope: "questionable", updateChannel: "stable", tagDisplay,
    });
    mockIPC((cmd, args) => {
      if (cmd === "shell_settings") return view(saved);
      if (cmd === "set_tag_display") {
        // 按收到的顺序写入，回复要等测试放行。
        saved = (args as { display: TagDisplay }).display;
        const reply = view(saved);
        return new Promise<ShellSettingsView>((resolve) => waiting.push(() => resolve(reply)));
      }
      if (cmd === "plugin:library|safe_mode") return true;
      return undefined;
    }, { shouldMockEvents: true });
    const release = async () => {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()!();
      // 让回复走完 invoke 和 React 的重新渲染。
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const { high, outline } = await openAppearance();
    fireEvent.click(screen.getByRole("button", { name: "按出处分组" }));
    fireEvent.click(outline);
    await release();
    fireEvent.change(high, { target: { value: "0.75" } });
    // 修好后保存一次只发一个，后面的排队，所以要一个个放行到没有为止。
    while (waiting.length > 0) await release();
    expect(saved).toEqual({ style: "grouped", high: 0.75, low: 0.4, lowOutline: false });
    expect(screen.getByRole("switch", { name: "低档虚线框" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "按出处分组" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("保存失败时控件回到已保存的设置，之后的改动不夹带失败的那项", async () => {
    let saved: TagDisplay = { style: "bands", high: 0.8, low: 0.4, lowOutline: true };
    const view = (): ShellSettingsView => ({
      autostart: true, shortcuts: [], showApproxSource: false, forceSrgb: false, forceSrgbInEffect: false,
      runLog: false, keepSelectionOnSafeMode: false, pinEdgeContrast: false, safeModeScope: "questionable", updateChannel: "stable", tagDisplay: saved,
    });
    let failNext = true;
    mockIPC((cmd, args) => {
      if (cmd === "shell_settings") return view();
      if (cmd === "set_tag_display") {
        if (failNext) { failNext = false; throw "无法写入设置文件"; }
        saved = (args as { display: TagDisplay }).display;
        return view();
      }
      if (cmd === "plugin:library|safe_mode") return true;
      return undefined;
    }, { shouldMockEvents: true });
    const { outline } = await openAppearance();
    fireEvent.click(outline);
    await waitFor(() => expect(screen.getByText(/无法写入设置文件/)).toBeTruthy());
    await waitFor(() => expect(outline.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "按出处分组" }));
    await waitFor(() => expect(saved.style).toBe("grouped"));
    expect(saved).toEqual({ style: "grouped", high: 0.8, low: 0.4, lowOutline: true });
  });

  it("拒绝低档上限 ≥ 高档下限：说明原因，不保存", async () => {
    const store = backend();
    const { low, high } = await openAppearance();
    fireEvent.change(low, { target: { value: "0.80" } });
    expect((await screen.findByRole("alert")).textContent).toContain("低档上限要小于高档下限");
    fireEvent.change(high, { target: { value: "0.35" } });
    expect(screen.getByRole("alert").textContent).toContain("低档上限要小于高档下限");
    expect(store.sent).toEqual([]);
    expect(store.saved()).toEqual({ style: "bands", high: 0.8, low: 0.4, lowOutline: true });
  });

  it("“恢复默认”回到 0.80 / 0.40", async () => {
    const store = backend();
    const { high, low } = await openAppearance();
    fireEvent.change(high, { target: { value: "0.9" } });
    fireEvent.change(low, { target: { value: "0.5" } });
    await waitFor(() => expect(store.saved()).toMatchObject({ high: 0.9, low: 0.5 }));
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await waitFor(() => expect(store.saved()).toEqual({ style: "bands", high: 0.8, low: 0.4, lowOutline: true }));
    expect(high.value).toBe("0.80");
    expect(low.value).toBe("0.40");
  });

  it("设置在重新挂载后仍然保留", async () => {
    backend();
    const first = await openAppearance();
    fireEvent.change(first.low, { target: { value: "0.45" } });
    fireEvent.click(screen.getByRole("button", { name: "按出处分组" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "按出处分组" }).getAttribute("aria-pressed")).toBe("true"));
    cleanup();
    const again = await openAppearance();
    expect(again.low.value).toBe("0.45");
    expect(screen.getByRole("button", { name: "按出处分组" }).getAttribute("aria-pressed")).toBe("true");
  });
});
