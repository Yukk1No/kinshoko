import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { Viewer } from "./Viewer";
import { fakeBackend } from "../test/backend";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { events.set(name, callback); return () => events.delete(name); }) }));

/** 图片读完：派发 load，再等 decode() 的那一拍，查看器才换上这张图。 */
const decoded = async (image: HTMLElement) => { fireEvent.load(image); await act(async () => {}); };
const translation = (image: HTMLElement) => image.style.transform.slice("translate(".length).split(",").map(parseFloat);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
  mockConvertFileSrc("windows");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("查看器设备像素", () => {
  it("F1 reads only the currently loaded image through a fresh native request", async () => {
    const reports: any[] = [];
    fakeBackend({ image: {}, report_capture_references: (args) => { reports.push(args); return null; } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    const { unmount } = render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    await waitFor(() => expect(events.has("capture-reference-request")).toBe(true));
    await act(async () => events.get("capture-reference-request")!({ payload: { request: "unloaded" } }));
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0].frame.references).toEqual([]);
    const image = screen.getByAltText("正在查看的参考图");
    Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 1500 }, naturalHeight: { configurable: true, value: 1000 } });
    await decoded(image);
    await act(async () => events.get("capture-reference-request")!({ payload: { request: "loaded" } }));
    await waitFor(() => expect(reports).toHaveLength(2));
    expect(reports[1]).toMatchObject({ request: "loaded", frame: { references: [{ libraryId: "L1", imageId: "a", shown: { x: 0, y: 100, width: 1500, height: 1000 }, visible: { x: 0, y: 100, width: 1500, height: 1000 } }] } });
    unmount();
  });

  it("工具栏起点不是完整设备像素时，仍按整个窗口对齐图片起点", () => {
    const position = new DOMRect(0.25, 47.25, 1000, 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(position);
    render(<Viewer libraryId="L1" card={{ id: "a", width: 101, height: 67, thumbnail: "", adult: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
    const image = screen.getByAltText("正在查看的参考图");
    const [left, top] = translation(image);
    const x = (position.left + left) * window.devicePixelRatio;
    const y = (position.top + top) * window.devicePixelRatio;
    expect(x).toBeCloseTo(Math.round(x));
    expect(y).toBeCloseTo(Math.round(y));
  });
  it("连续缩小时等滚轮停下再请求精确派生图，期间已读完的位图按新尺寸临时顶上（#128）", async () => {
    vi.useFakeTimers();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const image = screen.getByAltText("正在查看的参考图");
    const stage = image.parentElement!;
    await decoded(image);
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    // 滚轮当帧就有可见响应：旧位图跟着缩放，不等 Rust 生成派生图。
    const pending = screen.getByAltText("正在查看的参考图");
    expect(pending.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(pending.style.visibility).toBe("visible");
    expect(parseFloat(pending.style.width)).toBeLessThan(1000);
    expect(screen.queryByText("正在读取参考图…")).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    const settled = screen.getByAltText("正在查看的参考图");
    expect(settled.getAttribute("src")).toBe(`http://thumb.localhost/L1/a/fit-${Math.round(parseFloat(settled.style.width) * 1.5)}`);
    expect(settled.style.visibility).toBe("hidden");
    // 精确图读完前，旧位图摆在同一位置、同一尺寸；读完后换下。
    const stand = stage.querySelector<HTMLImageElement>("img.viewer-stand-in")!;
    expect(stand.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(stand.style.width).toBe(settled.style.width);
    expect(stand.style.transform).toBe(settled.style.transform);
    await decoded(settled);
    expect(settled.style.visibility).toBe("visible");
    expect(stage.querySelector("img.viewer-stand-in")).toBeNull();
  });
  it("从原始像素缩小时用已读完的缩小派生图顶上，不让 Chromium 每帧重采样整张原图（#128）", async () => {
    vi.useFakeTimers();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    await decoded(screen.getByAltText("正在查看的参考图"));
    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
    const original = screen.getByAltText("正在查看的参考图");
    expect(original.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    await decoded(original);
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    const stand = stage.querySelector<HTMLImageElement>("img.viewer-stand-in")!;
    expect(stand.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(stand.style.width).toBe(original.style.width);
    // 派生图画得出来之前，原图留着，不空白一帧。
    expect(original.style.visibility).toBe("visible");
    await decoded(stand);
    expect(original.style.visibility).toBe("hidden");
  });
  it("连续放大跨过 100% 时等停手再请求原图，大图不在手势中间上屏（#128）", async () => {
    vi.useFakeTimers();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    await decoded(screen.getByAltText("正在查看的参考图"));
    fireEvent.wheel(stage, { deltaY: -600, clientX: 500, clientY: 400 });
    const shown = screen.getByAltText("正在查看的参考图");
    expect(parseFloat(shown.style.width) * 1.5).toBeGreaterThan(2400);
    expect(shown.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    expect(shown.style.visibility).toBe("visible");
    // 100% 以上 desiredPx 不再变化，但还在缩放：每一格都重新计时。
    for (let i = 0; i < 3; i++) {
      fireEvent.wheel(stage, { deltaY: -50, clientX: 500, clientY: 400 });
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByAltText("正在查看的参考图").getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    }
    act(() => vi.advanceTimersByTime(200));
    const original = screen.getByAltText("正在查看的参考图");
    expect(original.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    expect(stage.querySelector("img.viewer-stand-in")?.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
  });
  it("缩放中换到另一张图，按这张图的尺寸请求，不沿用上一张的宽度", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Viewer libraryId="L1" card={{ id: "a", width: 6000, height: 4000, thumbnail: "", adult: false }} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    fireEvent.load(screen.getByAltText("正在查看的参考图"));
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.load(screen.getByAltText("正在查看的参考图"));
    rerender(<Viewer libraryId="L1" card={{ id: "b", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const next = screen.getByAltText("正在查看的参考图");
    expect(next.getAttribute("src")).toBe(`http://thumb.localhost/L1/b/fit-${Math.round(parseFloat(next.style.width) * 1.5)}`);
    expect(stage.querySelector("img.viewer-stand-in")).toBeNull();
  });
  it("精确来源读取失败时只显示错误，不留替身", async () => {
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    await decoded(screen.getByAltText("正在查看的参考图"));
    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
    expect(stage.querySelector("img.viewer-stand-in")?.getAttribute("src")).toBe("http://thumb.localhost/L1/a/fit-1500");
    fireEvent.error(screen.getByAltText("正在查看的参考图"));
    expect(screen.getByRole("alert").textContent).toContain("无法读取这张参考图");
    // 派生图替身的元素常驻但隐藏；不能有画得出来的替身。
    expect([...stage.querySelectorAll<HTMLImageElement>("img.viewer-stand-in")].filter((i) => i.style.visibility !== "hidden")).toEqual([]);
  });
  it("快速反复缩放时同一时刻只等一张派生图，读完再请求最新尺寸", async () => {
    // WebView2 不取消被换掉的请求；每次停顿都发新派生图会让 Rust 端积压整图解码，查看器长时间停在“正在读取”。
    vi.useFakeTimers();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 6000, height: 4000, thumbnail: "", adult: false }} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    await decoded(screen.getByAltText("正在查看的参考图"));
    const src = () => screen.getByAltText("正在查看的参考图").getAttribute("src");
    fireEvent.wheel(stage, { deltaY: 100, clientX: 500, clientY: 400 });
    act(() => vi.advanceTimersByTime(200));
    const first = src();
    expect(first).toMatch(/fit-\d+$/);
    for (const deltaY of [-150, 120, -90, 200]) {
      fireEvent.wheel(stage, { deltaY, clientX: 500, clientY: 400 });
      act(() => vi.advanceTimersByTime(200));
      expect(src()).toBe(first);
    }
    expect(screen.queryByText("正在读取参考图…")).toBeNull();
    expect(stage.querySelector("img.viewer-stand-in")?.getAttribute("src")).not.toBe(first);
    await decoded(screen.getByAltText("正在查看的参考图"));
    act(() => vi.advanceTimersByTime(200));
    const latest = screen.getByAltText("正在查看的参考图");
    expect(latest.getAttribute("src")).toBe(`http://thumb.localhost/L1/a/fit-${Math.round(parseFloat(latest.style.width) * 1.5)}`);
    await decoded(latest);
    expect(latest.style.visibility).toBe("visible");
  });
  it.each([1, 1.25, 1.5, 2])("DPR %s 下原图像素与 110％ 缩放都对齐物理像素，超过 200％ 按像素放大", (dpr) => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: dpr });
    render(<Viewer libraryId="L1" card={{ id: "odd", width: 101, height: 67, thumbnail: "", adult: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
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

    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
    image = screen.getByAltText("正在查看的参考图");
    expect(image.getAttribute("src")).toBe("http://thumb.localhost/L1/a/full");
    expect(image.style.width).toBe("1600px");
    expect(parseFloat(image.style.height)).toBeCloseTo(1600 / 1.5);
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");
  });

  it("读取失败有重试入口，拖动可以观察原图边缘；不是模态，没有关闭窗口的按钮", () => {
    const close = vi.fn();
    render(<Viewer libraryId="L1" card={{ id: "a", width: 2400, height: 1600, thumbnail: "", adult: false }} onClose={close} />);
    let image = screen.getByAltText("正在查看的参考图");
    fireEvent.error(image);
    expect(screen.getByRole("alert").textContent).toContain("无法读取这张参考图");
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    image = screen.getByAltText("正在查看的参考图");
    fireEvent.load(image);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^原始像素/ }));
    image = screen.getByAltText("正在查看的参考图");
    const before = translation(image)[0];
    const stage = image.parentElement!;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 400, clientY: 300, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 550, clientY: 300 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(translation(image)[0] - before).toBeCloseTo(150);

    // 只盖住图片墙所在的区域（#179）：不是模态对话框，窗口按钮仍在顶栏或详情侧栏上。
    const viewer = screen.getByRole("region", { name: "原图查看器" });
    expect(viewer.getAttribute("aria-modal")).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
    const first = screen.getByRole("button", { name: "返回图片墙" });
    first.focus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
});

