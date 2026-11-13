import { expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { WinCtrls } from "./WinCtrls";

let backend: FakeBackend;
let maximized: boolean;
/** 发出过的命令名，按先后。 */
const calls = () => backend.calls().map((call) => call.command);
function serve() {
  maximized = false;
  backend = fakeBackend({ is_maximized: () => maximized, minimize: null, toggle_maximize: null, close: null });
}

it("最小化、最大化与关闭调用主窗口自己的窗口接口", async () => {
  serve();
  render(<WinCtrls />);
  fireEvent.click(screen.getByRole("button", { name: "最小化" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(calls()).toEqual(expect.arrayContaining([
    "minimize", "toggle_maximize", "close",
  ])));
});

it("最大化后中间按钮换成还原，窗口还原后换回来", async () => {
  serve();
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
  serve();
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
