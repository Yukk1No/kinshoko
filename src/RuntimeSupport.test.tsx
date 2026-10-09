import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeDetails, RuntimeNotice, RuntimeProvider } from "./RuntimeSupport";

afterEach(() => { cleanup(); clearMocks(); vi.restoreAllMocks(); });

it("explains a failed required capability, opens the official update action and keeps browsing usable", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "runtime_status") return { webview2: "154.0.4258.62", assessment: { problems: ["当前 WebView2 无法建立二维画布，钉图无法显示。"], uses8bitFallback: false } };
    if (command === "diagnostics_report") return "本机脱敏报告\n无法建立二维画布，钉图无法显示。";
    return null;
  });
  render(<RuntimeProvider><RuntimeNotice /><button>打开参考图</button></RuntimeProvider>);
  expect((await screen.findByRole("alert")).textContent).toContain("无法建立二维画布，钉图无法显示");
  expect(screen.getByRole("button", { name: "打开参考图" })).toHaveProperty("disabled", false);
  expect(screen.getByText(/从托盘退出并重启 Kinshoko/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开微软 WebView2 下载页" }));
  await waitFor(() => expect(calls).toContain("open_runtime_update"));
  fireEvent.click(screen.getByRole("button", { name: "显示诊断信息" }));
  expect((await screen.findByLabelText("诊断信息")).textContent).toContain("本机脱敏报告");
});

it("keeps the required capability reason and recovery actions inside the settings runtime section", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  mockIPC((command) => command === "runtime_status" ? { webview2: "154.0.4258.62", assessment: { problems: ["当前 WebView2 无法建立二维画布，钉图无法显示。"], uses8bitFallback: false } } : null);
  render(<RuntimeProvider><RuntimeDetails /></RuntimeProvider>);
  expect((await screen.findByRole("alert")).textContent).toContain("无法建立二维画布，钉图无法显示");
  expect(screen.getByRole("button", { name: "打开微软 WebView2 下载页" })).toBeTruthy();
});
