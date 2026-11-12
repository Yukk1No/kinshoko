import { fireEvent, screen } from "@testing-library/react";
import type { ShellSettingsView } from "./bindings/ShellSettingsView";
import { fakeBackend, shellSettings, type Replies } from "./test/backend";

/** 每个设置测试之后撤掉测试用的选择；卸载界面与撤掉模拟在 src/test/setup.ts。 */
export function resetSettingsTest() {
  delete window.__KINSHOKO_TEST_PICKS__;
}

/** 切换到设置的某个分页。 */
export async function tab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  await screen.findByRole("heading", { name, level: 3 });
}

export const defaults: ShellSettingsView = shellSettings({
  autostart: true,
  shortcuts: [
    { action: "capture", accelerator: "F1", problem: { kind: "taken" } },
    { action: "pinClipboard", accelerator: "F3", problem: null },
    { action: "hideAllPins", accelerator: "F4", problem: null },
  ],
  runLog: true,
});

/** 设置测试的假后端：设置读回 `defaults`，其余命令照 `replies` 回答。 */
export function backend(replies: Replies = {}) {
  return fakeBackend({ shell_settings: defaults, ...replies });
}
