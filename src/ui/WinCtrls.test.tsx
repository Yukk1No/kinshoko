import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { WinCtrls } from "./WinCtrls";

let calls: string[];
let maximized: boolean;
function backend() {
  calls = [];
  maximized = false;
  mockWindows("main");
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "plugin:window|is_maximized") return maximized;
    return null;
  }, { shouldMockEvents: true });
}
afterEach(async () => { cleanup(); await act(async () => {}); clearMocks(); });

it("最小化、最大化与关闭调用主窗口自己的窗口接口", async () => {
  backend();
  render(<WinCtrls />);
  fireEvent.click(screen.getByRole("button", { name: "最小化" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(calls).toEqual(expect.arrayContaining([
    "plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close",
  ])));
});

it("最大化后中间按钮换成还原，窗口还原后换回来", async () => {
  backend();
  render(<WinCtrls />);
  expect(await screen.findByRole("button", { name: "最大化" })).toBeTruthy();
  maximized = true;
  await act(async () => { await emit("tauri://resize", { width: 1, height: 1 }); });
  expect(await screen.findByRole("button", { name: "还原" })).toBeTruthy();
  maximized = false;
  await act(async () => { await emit("tauri://resize", { width: 1, height: 1 }); });
  expect(await screen.findByRole("button", { name: "最大化" })).toBeTruthy();
});

it("图形按当前缩放画在设备像素网格上：150% 时 15 像素见方、线宽 2 像素", async () => {
  backend();
  const original = window.devicePixelRatio;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  try {
    const { container } = render(<WinCtrls />);
    await screen.findByRole("button", { name: "最大化" });
    const glyphs = [...container.querySelectorAll(".k-win-btn svg")];
    expect(glyphs).toHaveLength(3);
    for (const svg of glyphs) {
      expect(svg.getAttribute("viewBox")).toBe("0 0 15 15");
      expect(svg.getAttribute("stroke-width")).toBe("2");
      expect(Number(svg.getAttribute("width"))).toBeCloseTo(10);
    }
  } finally {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original });
  }
});

it("最大化时控件组带上 data-maximized，让样式把它贴到屏幕右上角；还原后去掉", async () => {
  backend();
  const { container } = render(<WinCtrls />);
  const group = () => container.querySelector(".k-win-ctrls")!;
  expect(await screen.findByRole("button", { name: "最大化" })).toBeTruthy();
  expect(group().hasAttribute("data-maximized")).toBe(false);
  maximized = true;
  await act(async () => { await emit("tauri://resize", { width: 1, height: 1 }); });
  await screen.findByRole("button", { name: "还原" });
  expect(group().hasAttribute("data-maximized")).toBe(true);
  maximized = false;
  await act(async () => { await emit("tauri://resize", { width: 1, height: 1 }); });
  await screen.findByRole("button", { name: "最大化" });
  expect(group().hasAttribute("data-maximized")).toBe(false);
});
