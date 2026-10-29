import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureEntry } from "../bindings/CaptureEntry";

// 截图面板（#62）的界面接线；IPC 与保存目标对话框用替身。
const ipc = vi.hoisted(() => ({
  history: vi.fn(),
  collect: vi.fn(() => Promise.resolve()),
  remove: vi.fn(() => Promise.resolve()),
  pin: vi.fn(() => Promise.resolve()),
  copy: vi.fn(() => Promise.resolve()),
  clipboard: vi.fn(() => Promise.resolve()),
  start: vi.fn(() => Promise.resolve()),
  settings: vi.fn(),
  minimize: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc", () => ({
  captureHistory: ipc.history,
  captureUrl: (id: string) => `capture://${id}`,
  collectCapture: ipc.collect,
  copyCapture: ipc.copy,
  deleteCapture: ipc.remove,
  onCaptureHistory: () => Promise.resolve(() => {}),
  pinCapture: ipc.pin,
  pinClipboard: ipc.clipboard,
  startCapture: ipc.start,
  shellSettings: ipc.settings,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ minimize: ipc.minimize }) }));
vi.mock("../library/SaveDestination", () => ({
  SaveDestinationDialog: ({ title, onConfirm, onClose }: { title: string; onConfirm: (d: unknown) => Promise<unknown>; onClose: () => void }) =>
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={() => void onConfirm({ libraryId: "lib-a", folderId: null }).then(onClose)}>确认收藏</button>
    </div>,
}));

import { CaptureHistoryPanel } from "./CaptureHistoryPanel";

const now = new Date(2026, 9, 10, 14, 40).getTime();
const entry = (id: string, minutesAgo: number, extra: Partial<CaptureEntry> = {}): CaptureEntry =>
  ({ id, width: 412, height: 380, createdAt: now - minutesAgo * 60_000, pinned: false, collected: [], ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  ipc.settings.mockResolvedValue({ shortcuts: [
    { action: "capture", accelerator: "F1", problem: null },
    { action: "pinClipboard", accelerator: "F3", problem: null },
    { action: "hideAllPins", accelerator: "F4", problem: null },
  ] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function show(entries: CaptureEntry[], libraryId: string | undefined = "lib-a") {
  ipc.history.mockResolvedValue(entries);
  render(<CaptureHistoryPanel libraryId={libraryId} />);
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}
const row = (name: string) => screen.getByText(name).closest("li")!;

describe("截图面板", () => {
  it("钉住剪贴板带上实际的快捷键，说明怎样截图", async () => {
    await show([]);
    const clip = screen.getByRole("button", { name: /^钉住剪贴板/ });
    expect(within(clip).getByText("F3")).toBeTruthy();
    expect(screen.getByText("按 F1 截取屏幕。没收藏的旧截图会自动清理。")).toBeTruthy();
    await act(async () => { fireEvent.click(clip); });
    expect(ipc.clipboard).toHaveBeenCalledOnce();
  });

  it("快捷键被清除时不显示键，也不提它", async () => {
    ipc.settings.mockResolvedValue({ shortcuts: [{ action: "capture", accelerator: null, problem: null }, { action: "pinClipboard", accelerator: null, problem: null }] });
    await show([]);
    expect(screen.getByRole("button", { name: "钉住剪贴板" }).textContent).toBe("钉住剪贴板");
    expect(screen.getByText("没收藏的旧截图会自动清理。")).toBeTruthy();
  });

  it("每张截图写出时间、尺寸、多久以前与钉住状态", async () => {
    await show([entry("s1", 0, { pinned: true }), entry("s2", 27, { width: 1280, height: 720 })]);
    const time = (minutes: number) => new Date(now - minutes * 60_000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    expect(within(row(`截图 ${time(0)}`)).getByText("412 × 380").parentElement!.textContent).toBe("412 × 380刚刚已钉住");
    expect(within(row(`截图 ${time(27)}`)).getByText("1280 × 720").parentElement!.textContent).toBe("1280 × 720" + "27 分钟前");
  });

  it("收藏到明确选择的图库；已收藏的仍可再收藏到别处", async () => {
    await show([entry("s1", 3), entry("s2", 5, { collected: [{ libraryId: "lib-a" } as never] })]);
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(second).getByRole("button", { name: /已收藏/ })).toBeTruthy();
    expect(within(first).queryByText("已收藏")).toBeNull();
    fireEvent.click(within(first).getByRole("button", { name: "收藏" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "收藏截图" })).getByRole("button", { name: "确认收藏" })); });
    expect(ipc.collect).toHaveBeenCalledWith("s1", { libraryId: "lib-a", folderId: null });
  });

  it("钉住与删除走各自的入口", async () => {
    await show([entry("s1", 3)]);
    const item = screen.getByRole("listitem");
    await act(async () => { fireEvent.click(within(item).getByRole("button", { name: "钉住" })); });
    expect(ipc.pin).toHaveBeenCalledWith("s1");
    await act(async () => { fireEvent.click(within(item).getByRole("button", { name: "删除这张截图" })); });
    expect(ipc.remove).toHaveBeenCalledWith("s1");
  });

  it("复制按钮把这张截图复制到剪贴板", async () => {
    await show([entry("s1", 3)]);
    await act(async () => { fireEvent.click(within(screen.getByRole("listitem")).getByRole("button", { name: "复制" })); });
    expect(ipc.copy).toHaveBeenCalledWith("s1");
  });

  it("右键条目：与主窗口同样式的菜单——钉住 · 复制 · 收藏到… · ─ · 删除（#106）", async () => {
    await show([entry("s1", 3), entry("s2", 5)]);
    const open = async () => {
      fireEvent.contextMenu(document.querySelector('[data-id="s2"]')!);
      const menu = await screen.findByRole("menu", { name: "截图菜单" });
      return menu;
    };
    const menu = await open();
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["钉住", "复制", "收藏到…", "删除"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
    expect(within(menu).getByRole("menuitem", { name: "删除" }).className).toContain("is-danger");
    for (const [name, call] of [["钉住", ipc.pin], ["复制", ipc.copy], ["删除", ipc.remove]] as const) {
      await act(async () => { fireEvent.click(within(await open()).getByRole("menuitem", { name })); });
      expect(call).toHaveBeenCalledWith("s2");
    }
    await act(async () => { fireEvent.click(within(await open()).getByRole("menuitem", { name: "收藏到…" })); });
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "收藏截图" })).getByRole("button", { name: "确认收藏" })); });
    expect(ipc.collect).toHaveBeenCalledWith("s2", { libraryId: "lib-a", folderId: null });
  });

  it("截图前先让开主窗口", async () => {
    vi.useRealTimers();
    await show([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^截图/ })); await new Promise((r) => setTimeout(r, 300)); });
    expect(ipc.minimize).toHaveBeenCalledOnce();
    expect(ipc.start).toHaveBeenCalledOnce();
  });

  it("失败写在面板里", async () => {
    ipc.clipboard.mockRejectedValueOnce("剪贴板里没有图片");
    await show([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^钉住剪贴板/ })); });
    expect(screen.getByRole("alert").textContent).toBe("剪贴板里没有图片");
  });
});
