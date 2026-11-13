import { thumbnailTier } from "./wall/thumbnailTier";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { resize as report } from "./test/platform";
import { library, page, tags, showApproxSource, keepSelectionOnSafeMode, calls, setCalls, clean, backend, sent, importAction, expandLibrary, setInspectorOpen, wallPage } from "./App.fixtures";

/** 宽度变了：工作区与图片墙各自的 ResizeObserver 报告一次。 */
const reportResize = () => act(() => { for (const el of document.querySelectorAll(".app-body, .wall")) report(el); });

describe("主窗口", () => {
  it("查找头部显示真实结果数，图片大小滑块改变布局，导入操作按需展开", async () => {
    backend(library, clean, (command, args) => {
      if (command === "plugin:library|workspace_browse" && (args as { query: { scope: { scope?: { kind: string } } } }).query.scope.scope?.kind.startsWith("folder")) return wallPage({ cards: [page.cards[0]], total: 1, nextCursor: null });
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

  it("图片墙上 Ctrl+滚轮：滑条同步移动，停手后提交并按新尺寸取缩略图（#111），不重新浏览（#313）", async () => {
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
    const tier = thumbnailTier(Math.ceil(320 * 1.5 * (window.devicePixelRatio || 1)));
    await waitFor(() => expect(wall.querySelector("img")!.getAttribute("src")).toMatch(new RegExp(`/${tier}$`)));
    expect(calls.some((c) => c.cmd === "plugin:library|workspace_browse" || c.cmd === "plugin:library|browse")).toBe(false);
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

  it("尚未打开资料库时仍能从图标轨打开截图", async () => {
    backend(null);
    render(<App />);
    await screen.findByRole("button", { name: "新建图库" });
    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    expect(await screen.findByRole("region", { name: "截图" })).toBeTruthy();
  });

  it("查找区域的标签分组展开后可以添加、取消条件，并保留文件夹范围", async () => {
    backend(library, clean, (command) => command === "plugin:library|workspace_tag_groups" ? [{
      id: "G1", name: "发色", namespace: null, tags: [{ tag: tags.B, count: 1 }],
    }] : undefined);
    render(<App />);
    await expandLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "人物（1 张）" }));
    const bar = await screen.findByRole("toolbar", { name: "标签分组" });
    fireEvent.click(within(bar).getByRole("button", { name: "发色" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /发色/ })).getByRole("button", { name: /蓝发/ }));
    expect(await screen.findByRole("list", { name: "查找条件" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toContain("蓝发"));
    expect(screen.getByRole("button", { name: "人物（1 张）" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(screen.getByRole("dialog", { name: /发色/ })).getByRole("button", { name: /蓝发/ }));
    await waitFor(() => expect(screen.getByRole("list", { name: "查找条件" }).textContent).toBe(""));
  });

  it("侧栏开合时图片墙一开始就按终点宽度排好，过渡中与结束时不再重排，并保持阅读偏移", async () => {
    let available = 1000;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
    // 详情面板按新装的默认关着：这里只看侧栏。
    setInspectorOpen(false);
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    const sidebar = document.querySelector<HTMLElement>(".sidebar-slot")!;
    // 收起前侧栏宽 256：墙最终会宽 256。
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 256, 800));
    wall.scrollTop = 60;
    fireEvent.scroll(wall);
    const offset = parseFloat(card.style.top) - wall.scrollTop;
    const initial = parseFloat(card.style.width);
    const resize = (next: number) => { available = next; reportResize(); };
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    act(() => { sidebar.dispatchEvent(new TransitionEvent("transitionrun", { propertyName: "width" })); });
    const settled = parseFloat(card.style.width);
    expect(settled).toBeGreaterThan(initial);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
    for (const next of [1040, 1100, 1180, 1256]) resize(next);
    expect(parseFloat(card.style.width)).toBe(settled);
    act(() => { sidebar.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "width" })); });
    expect(parseFloat(card.style.width)).toBe(settled);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
  });

  it("详情面板开合时图片墙一开始就按终点宽度排好，过渡中与结束时不再重排，并保持阅读偏移（#450）", async () => {
    let available = 1000;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
    vi.stubGlobal("innerWidth", 1600);
    setInspectorOpen(false);
    backend(library);
    render(<App />);
    await screen.findAllByRole("img");
    const wall = screen.getByRole("listbox", { name: "图片墙" });
    const card = document.querySelector<HTMLElement>('[data-id="a"]')!;
    const inspector = document.querySelector<HTMLElement>(".inspector")!;
    const sidebar = document.querySelector<HTMLElement>(".sidebar-slot")!;
    // 现在详情 0、侧栏 256：详情打开后墙窄 320。
    vi.spyOn(inspector, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 800));
    vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 256, 800));
    wall.scrollTop = 60;
    fireEvent.scroll(wall);
    const offset = parseFloat(card.style.top) - wall.scrollTop;
    const initial = parseFloat(card.style.width);
    const resize = (next: number) => { available = next; reportResize(); };
    fireEvent.click(screen.getByRole("button", { name: "显示详情" }));
    await waitFor(() => expect(inspector.getAttribute("data-collapsed")).toBe("false"));
    // 过渡开始之前，墙还是原来的布局。
    expect(parseFloat(card.style.width)).toBe(initial);
    act(() => { inspector.dispatchEvent(new TransitionEvent("transitionrun", { propertyName: "width" })); });
    const settled = parseFloat(card.style.width);
    expect(settled).toBeLessThan(initial);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
    for (const next of [960, 880, 760, 680]) resize(next);
    expect(parseFloat(card.style.width)).toBe(settled);
    act(() => { inspector.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "width" })); });
    expect(parseFloat(card.style.width)).toBe(settled);
    expect(parseFloat(card.style.top) - wall.scrollTop).toBeCloseTo(offset);
  });

  it("拖动详情面板边缘时图片墙不逐帧重排，松手后重排一次（#157）", async () => {
    let available = 1000;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => available });
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
      reportResize();
      expect(card.style.width).toBe(initial);
    }
    fireEvent.pointerUp(handle, { clientX: 900, pointerId: 1 });
    expect(card.style.width).not.toBe(initial);
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    await waitFor(() => expect(sent("change_setting:inspectorWidth")).toEqual([{ width: 420 }]));
  });

  it("详情面板的宽度是本设备设置：重新打开主窗口后沿用上次的宽度（#157）", async () => {
    vi.stubGlobal("innerWidth", 1600);
    // 工作区够宽，详情面板不用为主区让位（#274）。
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1544 });
    let saved: number | undefined;
    backend(library, clean, (cmd, args) => {
      if (cmd === "change_setting:inspectorWidth") { saved = (args as { width: number }).width; return { autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode, inspectorWidth: saved, inspectorOpen: true }; }
      if (cmd === "shell_settings") return { autostart: true, shortcuts: [], showApproxSource, keepSelectionOnSafeMode, inspectorWidth: saved, inspectorOpen: true };
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

  it("图标轨切换上下文侧栏时保留查找和图片墙，点当前图标收起侧栏，收起后点别的图标或按 Ctrl+数字展开", async () => {
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
    const browse = within(nav).getByRole("button", { name: "图片与文件夹" });
    fireEvent.click(browse);
    expect(browse.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("complementary", { name: "文件夹" })).toBeTruthy();
    fireEvent.click(browse);
    expect(browse.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(groups.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(browse);
    expect(screen.getByRole("complementary", { name: "文件夹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "工作参考 的操作" })).toBeTruthy();
  });

});
