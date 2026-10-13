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
  expect(within(bar).getByText("原图像素")).toBeTruthy();
  return bar;
};
const translation = (image: HTMLElement) => image.style.transform.slice("translate(".length).split(",").map(parseFloat);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("查看器设备像素", () => {
  it("F1 reads only the currently loaded image through a fresh native request", async () => {
    const reports: any[] = [];
    mockIPC((command, args) => {
      if (command === "plugin:desktop|report_capture_references") reports.push(args);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    const { unmount } = render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    await waitFor(() => expect(events.has("capture-reference-request")).toBe(true));
    await act(async () => events.get("capture-reference-request")!({ payload: { request: "unloaded" } }));
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0].frame.references).toEqual([]);
    const image = screen.getByAltText("正在查看的参考图");
    Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 1500 }, naturalHeight: { configurable: true, value: 1000 } });
    fireEvent.load(image);
    await act(async () => events.get("capture-reference-request")!({ payload: { request: "loaded" } }));
    await waitFor(() => expect(reports).toHaveLength(2));
    expect(reports[1]).toMatchObject({ request: "loaded", frame: { references: [{ libraryId: "L1", imageId: "a", shown: { x: 0, y: 100, width: 1500, height: 1000 }, visible: { x: 0, y: 100, width: 1500, height: 1000 } }] } });
    unmount();
    clearMocks();
  });

  it("工具栏起点不是完整设备像素时，仍按整个窗口对齐图片起点", () => {
    const position = new DOMRect(0.25, 47.25, 1000, 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(position);
    render(<Viewer libraryId="L1" card={{ id: "a", width: 101, height: 67, thumbnail: "", adult: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^原图像素/ }));
    const image = screen.getByAltText("正在查看的参考图");
    const [left, top] = translation(image);
    const x = (position.left + left) * window.devicePixelRatio;
    const y = (position.top + top) * window.devicePixelRatio;
    expect(x).toBeCloseTo(Math.round(x));
    expect(y).toBeCloseTo(Math.round(y));
  });
  it("连续缩小时等滚轮停下再请求精确派生图，不缩小旧位图", () => {
    vi.useFakeTimers();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const image = screen.getByAltText("正在查看的参考图");
    const stage = image.parentElement!;
    fireEvent.load(image);
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    const pending = screen.getByAltText("正在查看的参考图");
    expect(pending.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(pending.style.visibility).toBe("hidden");
    act(() => vi.advanceTimersByTime(1000));
    const settled = screen.getByAltText("正在查看的参考图");
    expect(settled.getAttribute("src")).toBe(`http://thumb.localhost/L1/a/fit-${Math.round(parseFloat(settled.style.width) * 1.5)}`);
  });
  it.each([1, 1.25, 1.5, 2])("DPR %s 下原图像素与 110％ 缩放都对齐物理像素，超过 200％ 按像素放大", (dpr) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
    render(<Viewer libraryId="L1" card={{ id: "odd", width: 101, height: 67, thumbnail: "", adult: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^原图像素/ }));
    const image = screen.getByAltText("正在查看的参考图");
    const physical = (property: "width" | "height" | "left" | "top") =>
      (property === "left" ? translation(image)[0] : property === "top" ? translation(image)[1] : parseFloat(image.style[property])) * dpr;
    expect(physical("width")).toBeCloseTo(101);
    expect(physical("height")).toBeCloseTo(67);
    expect(physical("left")).toBeCloseTo(Math.round(physical("left")));
    expect(physical("top")).toBeCloseTo(Math.round(physical("top")));

    fireEvent.wheel(image.parentElement!, { deltaY: -Math.log(1.1) / 0.002, clientX: 500, clientY: 400 });
    expect(physical("width")).toBeCloseTo(111);
    expect(physical("height")).toBeCloseTo(74);
    expect(image.style.imageRendering).toBe("auto");
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(physical("width")).toBeCloseTo(Math.round(physical("width")));
    expect(image.style.imageRendering).toBe("pixelated");
    expect(image.getAttribute("src")).toBe("http://thumb.localhost/L1/odd/full");
  });

  it("适应窗口请求精确物理宽度，原图像素按 DPR 除一次", () => {
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    let image = screen.getByAltText("正在查看的参考图");
    expect(image.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(image.style.width).toBe("1000px");
    expect(parseFloat(image.style.height)).toBeCloseTo(1000 / 1.5);

    fireEvent.click(screen.getByRole("button", { name: /^原图像素/ }));
    image = screen.getByAltText("正在查看的参考图");
    expect(image.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    expect(image.style.width).toBe("1600px");
    expect(parseFloat(image.style.height)).toBeCloseTo(1600 / 1.5);
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
  });

  it("读取失败有重试入口，拖动可以观察原图边缘，Tab 留在查看器中", () => {
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={close} />);
    let image = screen.getByAltText("正在查看的参考图");
    fireEvent.error(image);
    expect(screen.getByRole("alert").textContent).toContain("无法读取这张参考图");
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    image = screen.getByAltText("正在查看的参考图");
    fireEvent.load(image);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^原图像素/ }));
    image = screen.getByAltText("正在查看的参考图");
    const before = translation(image)[0];
    const stage = image.parentElement!;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 550, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(translation(image)[0] - before).toBeCloseTo(150);

    const first = screen.getByRole("button", { name: "返回图片墙" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^信息/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
});

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

  it("标题行有返回、文件名、序号、上一张 / 下一张和窗口控件", async () => {
    const step = vi.fn();
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={card} onClose={close} position={{ index: 11, total: 86 }} onStep={step} />);
    const header = screen.getByRole("banner");
    expect(await within(header).findByText("晨光练习_04.png")).toBeTruthy();
    expect(within(header).getByText("12 / 86")).toBeTruthy();
    for (const name of ["最小化", "最大化", "关闭"]) expect(within(header).getByRole("button", { name })).toBeTruthy();
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
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^原图像素/ }));
  });

  it("dock 的名称带快捷键；0 / 1 / P / F1 与点按 dock 执行同一操作", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} />);
    const dock = screen.getByRole("toolbar", { name: "查看工具" });
    const names = within(dock).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["适应窗口，0", "原图像素，1", "框选局部，F1", "钉住整图，P", "背景", "信息，I"]);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(/^适应窗口/)).toBe("true");
    fireEvent.keyDown(stage, { key: "1" });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
    expect(pressed(/^原图像素/)).toBe("true");
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

  it("信息（I）显示文件名、原图尺寸、缩放与操作提示", async () => {
    render(<Viewer libraryId="L1" card={card} onClose={() => {}} sourceName="角色参考" />);
    expect(screen.queryByRole("region", { name: "图片信息" })).toBeNull();
    fireEvent.keyDown(screen.getByAltText("正在查看的参考图").parentElement!, { key: "i" });
    const info = screen.getByRole("region", { name: "图片信息" });
    expect(await within(info).findByText("晨光练习_04.png")).toBeTruthy();
    expect(within(info).getByText("800 × 600 原图像素")).toBeTruthy();
    expect(within(info).getByText("角色参考")).toBeTruthy();
    expect(info.textContent).toContain("Shift+拖动框选局部");
    fireEvent.click(screen.getByRole("button", { name: /^信息/ }));
    expect(screen.queryByRole("region", { name: "图片信息" })).toBeNull();
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
