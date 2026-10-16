import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { PinView } from "./PinView";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); clearMocks(); vi.restoreAllMocks(); });

it("shows a recoverable runtime reason instead of leaving a failed canvas pin hidden", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  mockWindows("pin-P1");
  let visible = false;
  mockIPC((command) => {
    if (command === "plugin:desktop|pin_frame") return {
      pin: { id: "P1", content: { kind: "capture", captureId: "C1" }, crop: null, width: 300, height: 200, placement: { x: 80, y: 80, scale: 1, flipH: false, flipV: false, rotation: 0 }, opacity: 1, locked: false },
      window: { x: 80, y: 80, width: 300, height: 200 }, content: { x: 80, y: 80, width: 300, height: 200 }, motion: "jump", veiled: false, generation: 0,
    };
    if (command === "plugin:desktop|pin_ready") visible = true;
    return null;
  }, { shouldMockEvents: true });
  render(<PinView pin="P1" />);
  expect((await screen.findByRole("alert")).textContent).toContain("无法建立二维画布，钉图无法显示");
  await waitFor(() => expect(visible).toBe(true));
  expect(screen.getByRole("button", { name: "打开微软 WebView2 下载页" })).toBeTruthy();
});
