import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider, useToast, type ToastApi } from "./Toast";

afterEach(() => { cleanup(); vi.useRealTimers(); });

let api: ToastApi | null = null;
function Grab() { api = useToast(); return null; }

it("真实错误以轻提示报告：立即播报、不自动消失，按“知道了”才收起", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<ToastProvider><Grab /></ToastProvider>);
  act(() => { api!.error("无法切换安全模式：磁盘已满"); });
  expect((await screen.findByRole("alert")).textContent).toContain("磁盘已满");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByRole("alert").textContent).toContain("磁盘已满");
  fireEvent.click(screen.getByRole("button", { name: "知道了", hidden: true }));
  await waitFor(() => expect(screen.queryByText(/磁盘已满/)).toBeNull());
});

it("确认类提示带操作，过一会儿自动消失", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const undo = vi.fn();
  render(<ToastProvider><Grab /></ToastProvider>);
  act(() => { api!.show({ title: "已保存", tone: "success" }); });
  expect(await screen.findByText("已保存")).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(6_000); });
  await waitFor(() => expect(screen.queryByText("已保存")).toBeNull());
  act(() => { api!.show({ title: "已复制", tone: "success", action: { label: "撤销", onClick: undo } }); });
  fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
  expect(undo).toHaveBeenCalledTimes(1);
});

it("没有提示容器时返回 null，组件可以退回就地显示", () => {
  render(<Grab />);
  expect(api).toBeNull();
});
