import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { AppInfo } from "./bindings/AppInfo";
import { App } from "./App";

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("主窗口", () => {
  it("显示空的主区域，并在状态栏显示核心报告的版本", async () => {
    const info: AppInfo = { productName: "Kinshoko", version: "9.9.9" };
    mockIPC((cmd) => (cmd === "app_info" ? info : undefined));

    render(<App />);

    expect(await screen.findByText("Kinshoko 9.9.9")).toBeTruthy();
    expect(screen.getByRole("main").childElementCount).toBe(0);
  });

  it("从状态栏打开设置", async () => {
    mockIPC((cmd) => {
      if (cmd === "app_info") return { productName: "Kinshoko", version: "9.9.9" };
      if (cmd === "shell_settings") return { autostart: true, shortcuts: [] };
      return undefined;
    });
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("region", { name: "设置" })).toBeTruthy();
  });
});
