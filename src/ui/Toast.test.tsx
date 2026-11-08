import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { usePersistentToast, useToast, type PersistentToast, type ToastApi } from "./Toast";

afterEach(() => { cleanup(); vi.useRealTimers(); });

let api: ToastApi | null = null;
function Grab() { api = useToast(); return null; }

it("真实错误以轻提示报告：立即播报、不自动消失，按“知道了”才收起", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<><Grab /></>);
  act(() => { api!.error("无法切换安全模式：磁盘已满"); });
  expect((await screen.findByRole("alert")).textContent).toContain("磁盘已满");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByRole("alert").textContent).toContain("磁盘已满");
  fireEvent.click(screen.getByRole("button", { name: "知道了", hidden: true }));
  await waitFor(() => expect(screen.queryByText(/磁盘已满/)).toBeNull());
});

it("错误轻提示的读屏副本照常播报，按文字查找只找到看得见的那份", async () => {
  render(<><Grab /></>);
  act(() => { api!.error("资料库正忙"); });
  await screen.findByRole("alert");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(screen.getByRole("alert").textContent).toContain("资料库正忙");
  expect(screen.getByText("资料库正忙").tagName).toBe("H2");
});

it("确认类提示带操作，过一会儿自动消失", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const undo = vi.fn();
  render(<><Grab /></>);
  act(() => { api!.show({ title: "已保存", tone: "success" }); });
  expect(await screen.findByText("已保存")).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(6_000); });
  await waitFor(() => expect(screen.queryByText("已保存")).toBeNull());
  act(() => { api!.show({ title: "已复制", tone: "success", action: { label: "撤销", onClick: undo } }); });
  fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
  expect(undo).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByText("已复制")).toBeNull());
});

it("操作标了 keepOpen 时点了不关，留给调用方就地更新", async () => {
  const install = vi.fn();
  render(<><Grab /></>);
  act(() => { api!.show({ title: "可以更新", timeout: 0, action: { label: "安装", onClick: install, keepOpen: true } }); });
  fireEvent.click(await screen.findByRole("button", { name: "安装" }));
  expect(install).toHaveBeenCalledTimes(1);
  await new Promise((done) => setTimeout(done, 400));
  expect(screen.getByText("可以更新")).toBeTruthy();
});

it("就地更新已显示的提示：换内容、去掉操作，关掉时仍回调原来的 onClose", async () => {
  const onClose = vi.fn();
  render(<><Grab /></>);
  let id = "";
  act(() => { id = api!.show({ title: "可以更新", timeout: 0, action: { label: "安装", onClick: () => {} }, onClose }); });
  expect(await screen.findByRole("button", { name: "安装" })).toBeTruthy();
  act(() => { api!.update(id, { title: "正在下载", description: "3 MB", timeout: 0 }); });
  expect(await screen.findByText("正在下载")).toBeTruthy();
  expect(screen.getByText("3 MB")).toBeTruthy();
  expect(screen.queryByText("可以更新")).toBeNull();
  expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭提示", hidden: true }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("没有提示容器时直接报错", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => renderHook(() => useToast())).toThrow("useToast outside a ToastProvider");
  vi.restoreAllMocks();
});

describe("常驻通知", () => {
  const Notice = ({ notice, hidden, level }: { notice: PersistentToast | null; hidden?: boolean; level?: number }) => { usePersistentToast(notice, { hidden, level }); return null; };
  const shown = (title: string) => screen.queryByText(title) !== null;
  const dismiss = async (title: string) => {
    fireEvent.click(screen.getByRole("button", { name: "关闭提示", hidden: true }));
    await waitFor(() => expect(shown(title)).toBe(false));
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  it("不自动消失，内容原地更新，操作调用最新的回调", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = vi.fn(), second = vi.fn();
    const { rerender } = render(<Notice notice={{ title: "甲", action: { label: "处理", onClick: first } }} />);
    await screen.findByText("甲");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(shown("甲")).toBe(true);
    rerender(<Notice notice={{ title: "乙", action: { label: "处理", onClick: second } }} />);
    await screen.findByText("乙");
    expect(document.querySelectorAll(".k-toast")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "处理" }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("没有 level：关掉后不再弹，条件消失又出现才再弹", async () => {
    const { rerender } = render(<Notice notice={{ title: "甲" }} />);
    await screen.findByText("甲");
    await dismiss("甲");
    rerender(<Notice notice={{ title: "甲" }} />);
    await settle();
    expect(shown("甲")).toBe(false);
    rerender(<Notice notice={null} />);
    rerender(<Notice notice={{ title: "甲" }} />);
    expect(await screen.findByText("甲")).toBeTruthy();
  });

  it("有 level：关掉后只有超过关掉时的 level 才再弹，条件消失也不算", async () => {
    const { rerender } = render(<Notice notice={{ title: "甲" }} level={2} />);
    await screen.findByText("甲");
    await dismiss("甲");
    rerender(<Notice notice={null} level={0} />);
    rerender(<Notice notice={{ title: "甲" }} level={2} />);
    await settle();
    expect(shown("甲")).toBe(false);
    rerender(<Notice notice={{ title: "甲" }} level={3} />);
    expect(await screen.findByText("甲")).toBeTruthy();
  });

  it("hidden 只是让开：不算关掉，也不清除已关掉的记录", async () => {
    const { rerender } = render(<Notice notice={{ title: "甲" }} />);
    await screen.findByText("甲");
    rerender(<Notice notice={{ title: "甲" }} hidden />);
    await waitFor(() => expect(shown("甲")).toBe(false));
    rerender(<Notice notice={{ title: "甲" }} />);
    await screen.findByText("甲");
    await dismiss("甲");
    rerender(<Notice notice={{ title: "甲" }} hidden />);
    rerender(<Notice notice={{ title: "甲" }} />);
    await settle();
    expect(shown("甲")).toBe(false);
  });

  it("卸载时收起", async () => {
    const { rerender } = render(<Notice notice={{ title: "甲" }} />);
    await screen.findByText("甲");
    rerender(<></>);
    await waitFor(() => expect(shown("甲")).toBe(false));
  });
});
