import { cleanup, fireEvent, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";

/** 每个设置测试之后：卸载界面、撤掉模拟与测试用的选择。 */
export async function resetSettingsTest() {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  delete window.__KINSHOKO_TEST_PICKS__;
}

/** 切换到设置的某个分页。 */
export async function tab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  await screen.findByRole("heading", { name, level: 3 });
}

export const defaults: ShellSettingsView = {
  autostart: true,
  shortcuts: [
    { action: "capture", accelerator: "F1", problem: "已被其他程序占用" },
    { action: "pinClipboard", accelerator: "F3", problem: null },
    { action: "hideAllPins", accelerator: "F4", problem: null },
  ],
  showApproxSource: false,
  forceSrgb: false,
  forceSrgbInEffect: false,
  runLog: true,
  keepSelectionOnSafeMode: false,
  pinEdgeContrast: false,
  safeModeScope: "questionable",
  tagDisplay: { style: "bands", high: 0.8, low: 0.4, lowOutline: true },
  updateChannel: "stable",
};

/** 记录前端发出的命令，按给定的处理函数回应。 */
export function backend(handle: (cmd: string, args: Record<string, unknown>) => unknown) {
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
