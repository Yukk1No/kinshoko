import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { UpdateBanner } from "./Update";

afterEach(() => {
  cleanup();
  clearMocks();
});

function backend(handle: (cmd: string) => unknown) {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return handle(cmd);
  });
  return calls;
}

describe("主窗口的更新提示", () => {
  it("还没检查过时检查一次，有新版本就提示，可以安装", async () => {
    const calls = backend((cmd) => {
      if (cmd === "update_status") return { state: "unchecked" };
      if (cmd === "check_update") return { state: "available", version: "0.2.0", notes: null };
      return null;
    });
    render(<UpdateBanner />);

    expect(await screen.findByText("Kinshoko 0.2.0 可以更新。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    await waitFor(() => expect(calls).toContain("install_update"));
  });

  it("以后再说就收起提示", async () => {
    backend((cmd) =>
      cmd === "update_status" ? { state: "available", version: "0.2.0", notes: null } : null,
    );
    render(<UpdateBanner />);

    fireEvent.click(await screen.findByRole("button", { name: "以后再说" }));

    expect(screen.queryByText(/可以更新/)).toBeNull();
  });

  it("本次运行已经检查过或未启用更新时不再联网", async () => {
    for (const state of ["upToDate", "disabled"]) {
      const calls = backend((cmd) => (cmd === "update_status" ? { state } : null));
      render(<UpdateBanner />);
      await waitFor(() => expect(calls).toContain("update_status"));
      expect(calls).not.toContain("check_update");
      expect(screen.queryByRole("status")).toBeNull();
      cleanup();
    }
  });
});
