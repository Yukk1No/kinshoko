import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
