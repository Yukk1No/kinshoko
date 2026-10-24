import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { library, page, tags, showApproxSource, keepSelectionOnSafeMode, calls, setCalls, clean, backend, sent, importAction, expandLibrary } from "./App.fixtures";

describe("主窗口", () => {
  it("查找头部显示真实结果数，图片大小滑块改变布局，导入操作按需展开", async () => {
    backend(library, clean, (command, args) => {
      if (command === "plugin:library|browse" && (args as { query: { scope: { kind: string } } }).query.scope.kind.startsWith("folder")) return { cards: [page.cards[0]], total: 1, nextCursor: null };
    });
    render(<App />);
    await screen.findAllByRole("img");
    const result = screen.getByRole("status", { name: "查找结果" });
    await waitFor(() => expect(result.textContent).toBe("2 张"));
    const card = screen.getByRole("listbox", { name: "图片墙" }).querySelector<HTMLElement>(".card")!;
    const before = parseFloat(card.style.width);
    const slider = screen.getByRole("slider", { name: "图片大小" });
    fireEvent.change(slider, { target: { value: "420" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(parseFloat(card.style.width)).toBeGreaterThan(before));
    expect(screen.queryByRole("menuitem", { name: /^文件夹/ })).toBeNull();
    expect(importAction("导入文件夹…")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /^文件夹/ }), { key: "Escape" });
    await expandLibrary();
    fireEvent.click(screen.getByRole("button", { name: "人物（1 张）" }));
    await waitFor(() => expect(result.textContent).toBe("1 张"));
  });

  it("图片墙上 Ctrl+滚轮：滑条同步移动，停手后提交并按新尺寸取缩略图（#111）", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const slider = screen.getByRole("slider", { name: "图片大小" }) as HTMLInputElement;
    const card = wall.querySelector<HTMLElement>(".card")!;
    const before = parseFloat(card.style.width);
    setCalls([]);
    expect(fireEvent.wheel(wall, { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50 })).toBe(false);
    fireEvent.wheel(wall, { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50 });
    fireEvent.wheel(wall, { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 50 });
    expect(slider.value).toBe("320");
    expect(parseFloat(wall.querySelector<HTMLElement>(".card")!.style.width)).toBeGreaterThan(before);
    expect(calls.some((c) => c.cmd === "plugin:library|browse")).toBe(false);
    await waitFor(() => expect(calls.some((c) => c.cmd === "plugin:library|browse")).toBe(true));
    const browsed = calls.filter((c) => c.cmd === "plugin:library|browse").at(-1)!.args as { query: { thumbnailPx: number } };
    expect(browsed.query.thumbnailPx).toBe(Math.ceil(320 * 1.5 * (window.devicePixelRatio || 1)));
    expect(slider.value).toBe("320");
  });

  it("顶栏（方案 C3）：张数与精确查找开关在顶栏，图片大小浮在图片墙右下角", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const topbar = screen.getByRole("combobox", { name: "查找参考图" }).closest("header")!;
    expect(topbar.contains(screen.getByRole("status", { name: "查找结果" }))).toBe(true);
    expect(topbar.contains(screen.getByRole("button", { name: "精确查找" }))).toBe(true);
    expect(topbar.contains(screen.getByRole("button", { name: "导入" }))).toBe(true);
    const island = screen.getByRole("group", { name: "图片大小" });
    expect(topbar.contains(island)).toBe(false);
    expect(island.closest("main")).toBe(screen.getByRole("listbox", { name: "图片墙" }).closest("main"));
  });

  it("尚未打开资料库时仍能从图标轨打开截图历史与钉剪贴板入口", async () => {
    backend(null);
    render(<App />);
    await screen.findByRole("button", { name: "新建图库" });
    fireEvent.click(screen.getByRole("button", { name: "截图历史" }));
    expect(await screen.findByRole("region", { name: "截图历史" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^钉住剪贴板/ })).toBeTruthy();
  });

  it("查找区域的标签分组展开后可以添加、取消条件，并保留文件夹范围", async () => {
    backend(library, clean, (command) => command === "plugin:library|tag_groups" ? [{
      id: "G1", name: "发色", namespace: null, tags: [{ tag: tags.B, count: 1 }],
    }] : undefined);
    render(<App />);
    await expandLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    const bar = await screen.findByRole("toolbar", { name: "标签分组" });
    fireEvent.click(within(bar).getByRole("button", { name: "发色" }));
    fireEvent.click(within(bar).getByRole("button", { name: /蓝发/ }));
    expect(await screen.findByRole("list", { name: "查找条件" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("蓝发"));
    expect(screen.getByRole("button", { name: "人物（1 张）" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(bar).getByRole("button", { name: /蓝发/ }));
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toBe(""));
  });

  it("收起侧栏过程中按每次可用宽度连续重排，并保持阅读偏移", async () => {
    let available = 1000;
    const observers = new Set<() => void>();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
    vi.stubGlobal("ResizeObserver", class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
      observe() {}
      disconnect() { observers.delete(this.callback); }
    });
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    wall.scrollTop = 60;
    fireEvent.scroll(wall);
    const offset = parseFloat(card.style.top) - wall.scrollTop;
    const initial = parseFloat(card.style.width);
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    available = 1100;
    act(() => observers.forEach((resize) => resize()));
    expect(parseFloat(card.style.width)).toBeGreaterThan(initial);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
    available = 1248;
    act(() => observers.forEach((resize) => resize()));
    expect(parseFloat(card.style.width)).toBeCloseTo(238.4);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
  });

  it("拖动详情面板边缘时图片墙不逐帧重排，松手后重排一次（#157）", async () => {
    let available = 1000;
    const observers = new Set<() => void>();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
    vi.stubGlobal("ResizeObserver", class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
      observe() {}
      disconnect() { observers.delete(this.callback); }
    });
    vi.stubGlobal("innerWidth", 1600);
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    // 用空格选中：单击后的双击间隔里图片墙本就不重排（#179），这里只看拖动。
    fireEvent.keyDown(card, { key: " " });
    const handle = screen.getByRole("separator", { name: "调整详情宽度" });
    const initial = card.style.width;
    fireEvent.pointerDown(handle, { clientX: 1000, button: 0, pointerId: 1 });
    for (const x of [980, 940, 900]) {
      fireEvent.pointerMove(handle, { clientX: x, pointerId: 1 });
      available = 1000 - (1000 - x);
      act(() => observers.forEach((resize) => resize()));
      expect(card.style.width).toBe(initial);
    }
    fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 });
    expect(card.style.width).not.toBe(initial);
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    await waitFor(() => expect(sent("set_inspector_width")).toEqual([{ width: 420 }]));
  });

  it("详情面板的宽度是本设备设置：重新打开主窗口后沿用上次的宽度（#157）", async () => {
    vi.stubGlobal("innerWidth", 1600);
    let saved: number | undefined;
    backend(library, clean, (cmd, args) => {
      if (cmd === "set_inspector_width") { saved = (args as { width: number }).width; return { autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode, inspectorWidth: saved }; }
      if (cmd === "shell_settings") return { autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode, inspectorWidth: saved };
      return undefined;
    });
    const first = render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(document.querySelector<HTMLElement>('[data-id="a"]')!);
    const handle = screen.getByRole("separator", { name: "调整详情宽度" });
    expect(handle.getAttribute("aria-valuenow")).toBe("320");
    fireEvent.pointerDown(handle, { clientX: 1000, button: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 870, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 870, pointerId: 1 });
    await waitFor(() => expect(saved).toBe(450));
    first.unmount();

    render(<App />);
    await screen.findAllByRole("img");
    fireEvent.click(document.querySelector<HTMLElement>('[data-id="a"]')!);
    await waitFor(() => expect(screen.getByRole("separator", { name: "调整详情宽度" }).getAttribute("aria-valuenow")).toBe("450"));
    expect(document.documentElement.style.getPropertyValue("--inspector-width")).toBe("450px");
  });

  it("图标轨切换上下文侧栏时保留查找和图片墙，重复点按收起侧栏", async () => {
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const groups = within(nav).getByRole("button", { name: "参考组" });
    fireEvent.click(groups);
    expect(await screen.findByRole("complementary", { name: "参考组" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "图片墙" })).toBe(wall);
    expect(screen.getByRole("combobox", { name: "查找参考图" })).toBeTruthy();
    fireEvent.click(groups);
    expect(groups.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(nav).getByRole("button", { name: "图片与文件夹" }));
    expect(screen.getByRole("complementary", { name: "文件夹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "工作参考 的操作" })).toBeTruthy();
  });

});
