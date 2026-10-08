import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { Viewer } from "./Viewer";

// JSDOM 不做布局；原生冒烟另用 getBoundingClientRect 检查最终设备像素位置。
const translation = (image: HTMLElement) => image.style.transform.slice("translate(".length).split(",").map(parseFloat);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("查看器设备像素", () => {
  it("只向 F1 报告已经显示的原图范围，关闭查看器后清除来源", async () => {
    const reports: unknown[] = [];
    mockIPC((command, args) => {
      if (command === "plugin:desktop|set_capture_reference") reports.push(args?.reference);
      return undefined;
    });
    const { unmount } = render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    expect(reports.at(-1)).toBeNull();
    fireEvent.load(screen.getByAltText("正在查看的参考图"));
    await waitFor(() => expect(reports.at(-1)).toEqual({
      libraryId: "L1", imageId: "a",
      shown: { x: 0, y: 100, width: 1500, height: 1000 },
      visible: { x: 0, y: 100, width: 1500, height: 1000 },
    }));
    unmount();
    await waitFor(() => expect(reports.at(-1)).toBeNull());
    clearMocks();
  });

  it("工具栏起点不是完整设备像素时，仍按整个窗口对齐图片起点", () => {
    const position = new DOMRect(0.25, 47.25, 1000, 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(position);
    render(<Viewer libraryId="L1" card={{ id: "a", width: 101, height: 67, thumbnail: "", adult: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "原图像素" }));
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
    fireEvent.click(screen.getByRole("button", { name: "原图像素" }));
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

    fireEvent.click(screen.getByRole("button", { name: "原图像素" }));
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

    fireEvent.click(screen.getByRole("button", { name: "原图像素" }));
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
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "查看器背景" }));
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
    expect(screen.getByText("200 × 100 px（原图像素）")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("200 × 100 px（原图像素）")).toBeTruthy();
    expect(screen.getByLabelText("选区").style.width).toBe("250px");
    fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));

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
      fireEvent.click(screen.getByRole("button", { name: "钉住整图" }));
    });
    expect(pins()).toEqual([{ libraryId: "L1", imageId: "a", crop: null, shown: { x: 100, y: 100, width: 800, height: 600 } }]);

    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    fireEvent.click(screen.getByRole("button", { name: "框选局部" }));
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    expect(screen.getByText("40 × 30 px（原图像素）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "框选局部" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(stage, { key: "Escape" });
    expect(screen.queryByLabelText("选区")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(stage, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
});
