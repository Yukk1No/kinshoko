import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Viewer } from "./Viewer";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { events.set(name, callback); return () => events.delete(name); }) }));

// JSDOM 不做布局；原生冒烟另用 getBoundingClientRect 检查最终设备像素位置。
/** The crop dock reads the selection size in original pixels (design/ui-system/README.md, Dock 读数). */
const cropReadout = (size: string) => {
  const bar = screen.getByRole("toolbar", { name: "框选" });
  expect(within(bar).getByText(size)).toBeTruthy();
  expect(within(bar).getByText("原始像素")).toBeTruthy();
  return bar;
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("从查看器钉到桌面（#65）", () => {
  const card = { id: "a", width: 800, height: 600, thumbnail: "", adult: false };
  let calls: { cmd: string; args: unknown }[];
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "plugin:library|image") return {};
      return null;
    });
  });
  afterEach(() => clearMocks());
  const pins = () => calls.filter((c) => c.cmd === "plugin:desktop|pin_reference").map((c) => c.args);

  it("Shift+拖动按原图像素框出局部，缩放时边界不变，Enter 钉住", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    // 适应窗口：800×600 的图居中在 1000×800 的舞台上，左上角 (100, 100)，一个 CSS 像素一个原图像素。
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 110, clientY: 110, button: 0, shiftKey: true });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 310, clientY: 210 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(cropReadout("200 × 100")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(cropReadout("200 × 100")).toBeTruthy();
    expect(screen.getByLabelText("选区").style.width).toBe("250px");
    fireEvent.click(screen.getByRole("button", { name: /^适应窗口/ }));

    await act(async () => {
      fireEvent.keyDown(stage, { key: "Enter" });
    });
    expect(pins()).toEqual([{
      libraryId: "L1",
      imageId: "a",
      crop: { x: 10, y: 10, width: 200, height: 100 },
      shown: { x: 110, y: 110, width: 200, height: 100 },
    }]);
    expect(await screen.findByText("已钉住局部")).toBeTruthy();
  });

  it("钉住整图；框选模式下普通拖动也框选；Esc 先清除选区再返回图片墙", async () => {
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={close} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^钉住整图/ }));
    });
    expect(pins()).toEqual([{ libraryId: "L1", imageId: "a", crop: null, shown: { x: 100, y: 100, width: 800, height: 600 } }]);

    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    fireEvent.click(screen.getByRole("button", { name: /^框选局部/ }));
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    expect(cropReadout("40 × 30")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^框选局部/ }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(stage, { key: "Escape" });
    expect(screen.queryByLabelText("选区")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(stage, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([["L1", "b"], ["L2", "a"]])("换到同尺寸来源 %s/%s 后，旧选区不可钉住，新框选引用新来源", async (libraryId, imageId) => {
    const { rerender } = render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    let image = screen.getByAltText("正在查看的参考图");
    fireEvent.load(image);
    const stage = image.parentElement!;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 110, clientY: 110, button: 0, shiftKey: true });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 310, clientY: 210 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    cropReadout("200 × 100");

    rerender(<Viewer libraryId={libraryId} card={{ ...card, id: imageId }} onClose={() => {}} />);
    image = screen.getByAltText("正在查看的参考图");
    fireEvent.load(image);
    expect(screen.queryByLabelText("选区")).toBeNull();
    expect(screen.queryByRole("button", { name: /^钉住局部/ })).toBeNull();
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(pins()).toEqual([]);

    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 100, clientY: 100, button: 0, shiftKey: true });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 150, clientY: 120 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    await act(async () => { fireEvent.keyDown(stage, { key: "Enter" }); });
    expect(pins()).toEqual([{ libraryId, imageId, crop: { x: 0, y: 0, width: 50, height: 20 }, shown: { x: 100, y: 100, width: 50, height: 20 } }]);
  });
});


describe("查看器程序配置", () => {
  const card = { id: "background", width: 800, height: 600, thumbnail: "", adult: false };
  afterEach(() => { clearMocks(); localStorage.clear(); });

  it("已恢复的背景优先于本机旧缓存，并保存后续选择", async () => {
    localStorage.setItem("kinshoko.viewer.background", "dark");
    const writes: unknown[] = [];
    mockIPC((command, args) => {
      if (command === "shell_settings") return { viewerBackground: "light" };
      if (command === "set_viewer_background") writes.push(args);
      if (command === "migrate_viewer_background") throw new Error("must not migrate again");
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    await waitFor(() => expect(writes).toEqual([{ background: "light" }]));
    fireEvent.click(screen.getByRole("button", { name: "背景" }));
    const tray = screen.getByRole("group", { name: "背景" });
    expect(within(tray).getByRole("button", { name: "浅灰" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(tray).getByRole("button", { name: "棋盘格" }));
    await waitFor(() => expect(writes.at(-1)).toEqual({ background: "checker" }));
    expect(screen.getByAltText("正在查看的参考图").parentElement!.dataset.background).toBe("checker");
  });

  it("首次读取程序配置失败时不把旧缓存写回", async () => {
    localStorage.setItem("kinshoko.viewer.background", "dark");
    const writes: unknown[] = [];
    mockIPC((command, args) => {
      if (command === "shell_settings") throw new Error("temporarily unavailable");
      if (command === "set_viewer_background" || command === "migrate_viewer_background") writes.push(args);
      return null;
    });
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    await act(async () => {});
    expect(writes).toEqual([]);
  });
});

describe("查看器标题行与 dock（#98）", () => {
  const card = { id: "a", width: 800, height: 600, thumbnail: "", adult: false };
  let calls: { cmd: string; args: unknown }[];
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    calls = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "plugin:library|image") return { originalName: "晨光练习_04.png" };
      return null;
    });
  });
  afterEach(() => clearMocks());
  const pins = () => calls.filter((c) => c.cmd === "plugin:desktop|pin_reference").map((c) => c.args);

  it("标题行有返回、文件名、序号、上一张 / 下一张；窗口控件留在顶栏或详情侧栏（#179）", async () => {
    const step = vi.fn();
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={close} position={{ index: 11, total: 86 }} onStep={step} />);
    const header = screen.getByRole("banner");
    expect(await within(header).findByText("晨光练习_04.png")).toBeTruthy();
    expect(within(header).getByText("12 / 86")).toBeTruthy();
    for (const name of ["最小化", "最大化", "关闭"]) expect(within(header).queryByRole("button", { name })).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "上一张" }));
    fireEvent.click(within(header).getByRole("button", { name: "下一张" }));
    expect(step.mock.calls).toEqual([[-1], [1]]);
    fireEvent.click(within(header).getByRole("button", { name: "返回图片墙" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("首尾两张禁用越界方向；← / → 也翻页，但 dock 内的方向键只移动焦点", () => {
    const step = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} position={{ index: 0, total: 2 }} onStep={step} />);
    expect((screen.getByRole("button", { name: "上一张" }) as HTMLButtonElement).disabled).toBe(true);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect(step.mock.calls).toEqual([[1]]);
    const fit = screen.getByRole("button", { name: /^适应窗口/ });
    fireEvent.keyDown(fit, { key: "ArrowRight" });
    expect(step.mock.calls).toEqual([[1]]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^原始像素/ }));
  });

  it("dock 的名称带快捷键；0 / 1 / P / F1 与点按 dock 执行同一操作", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const dock = screen.getByRole("toolbar", { name: "查看工具" });
    const names = within(dock).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["适应窗口，0", "原始像素，1", "框选局部，F1", "钉住整图，P", "背景", "显示详情，I"]);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(/^适应窗口/)).toBe("true");
    fireEvent.keyDown(stage, { key: "1" });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
    expect(pressed(/^原始像素/)).toBe("true");
    fireEvent.keyDown(stage, { key: "0" });
    expect(pressed(/^适应窗口/)).toBe("true");
    fireEvent.keyDown(stage, { key: "F1" });
    expect(pressed(/^框选局部/)).toBe("true");
    fireEvent.keyDown(stage, { key: "F1" });
    expect(pressed(/^框选局部/)).toBe("false");
    await act(async () => { fireEvent.keyDown(stage, { key: "p" }); });
    expect(pins()).toEqual([{ libraryId: "L1", imageId: "a", crop: null, shown: { x: 100, y: 100, width: 800, height: 600 } }]);
    expect(await screen.findByText("已钉住整图")).toBeTruthy();
  });

  it("I 键与 dock 的“详情”显示或隐藏旁边的详情侧栏（#179）；查看器自己没有信息浮层", async () => {
    const toggle = vi.fn();
    const view = render(<Viewer libraryId="L1" card={card} onClose={() => {}} inspectorOpen={false} onToggleInspector={toggle} />);
    fireEvent.keyDown(screen.getByAltText("正在查看的参考图").parentElement!, { key: "i" });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "图片信息" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^显示详情/ }));
    expect(toggle).toHaveBeenCalledTimes(2);
    view.rerender(<Viewer libraryId="L1" card={card} onClose={() => {}} inspectorOpen onToggleInspector={toggle} />);
    fireEvent.click(screen.getByRole("button", { name: /^隐藏详情/ }));
    expect(toggle).toHaveBeenCalledTimes(3);
    // 文件名在标题行，缩放比例在工具栏。
    expect(await screen.findByText("晨光练习_04.png")).toBeTruthy();
    expect(screen.getByLabelText("缩放比例").textContent).toMatch(/%$/);
  });

  it("框选 dock：钉住局部是主操作，重选清掉选区并重新框选，取消只清选区", async () => {
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={close} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    const drag = (id: number, x1: number, y1: number) => {
      fireEvent.pointerDown(stage, { pointerId: id, clientX: 110, clientY: 110, button: 0, shiftKey: true });
      fireEvent.pointerMove(stage, { pointerId: id, clientX: x1, clientY: y1 });
      fireEvent.pointerUp(stage, { pointerId: id });
    };
    drag(1, 310, 210);
    const bar = cropReadout("200 × 100");
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["钉住局部，Enter", "重选", "取消，Esc"]);
    expect(within(bar).getByRole("button", { name: /^钉住局部/ }).className).toContain("is-primary");
    expect(within(bar).getByRole("button", { name: /^取消/ }).className).toContain("is-danger");

    fireEvent.click(within(bar).getByRole("button", { name: "重选" }));
    expect(screen.queryByLabelText("选区")).toBeNull();
    expect(screen.getByRole("button", { name: /^框选局部/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 150, clientY: 120 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    cropReadout("50 × 20");

    await act(async () => { fireEvent.click(within(screen.getByRole("toolbar", { name: "框选" })).getByRole("button", { name: /^钉住局部/ })); });
    expect(pins()).toEqual([{ libraryId: "L1", imageId: "a", crop: { x: 0, y: 0, width: 50, height: 20 }, shown: { x: 100, y: 100, width: 50, height: 20 } }]);

    fireEvent.click(within(screen.getByRole("toolbar", { name: "框选" })).getByRole("button", { name: /^取消/ }));
    expect(screen.queryByLabelText("选区")).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("从图片墙进入框选（#102 右键“框选局部钉住”）", () => {
  it("startCrop 时打开即在框选模式，换到下一张后不再自动框选", () => {
    mockIPC(() => null);
    const card = (id: string) => ({ id, width: 400, height: 300, thumbnail: "", adult: false });
    const { rerender } = render(<Viewer libraryId="L1" card={card("a")} startCrop onClose={() => {}} />);
    const pressed = () => screen.getByRole("button", { name: /^框选局部/ }).getAttribute("aria-pressed");
    expect(pressed()).toBe("true");
    rerender(<Viewer libraryId="L1" card={card("b")} startCrop onClose={() => {}} />);
    expect(pressed()).toBe("false");
    clearMocks();
  });
});

