import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { CaptureOverlay } from "./CaptureOverlay";

let reduced = false;
vi.mock("motion/react", async (actual) => ({ ...(await actual<typeof import("motion/react")>()), useReducedMotion: () => reduced }));

let calls: { cmd: string; args: any }[];
/** 冻结时登记的参考图在框选窗口里的范围（物理像素）与原图倍率：选区完全落在里面时读原始像素。 */
let reference: { x: number; y: number; width: number; height: number; scale: number } | null;
/** 原生端此刻的冻结屏幕；会话结束时为 null。 */
let frozen: { image: string; width: number; height: number } | null;
beforeEach(() => {
  reduced = false;
  reference = null;
  frozen = { image: "screen/tok", width: 2400, height: 1500 };
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
  mockConvertFileSrc("windows");
  calls = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "plugin:desktop|frozen_screen") return frozen;
    if (cmd === "plugin:desktop|capture_readout") {
      const { region: r } = args as { region: { x: number; y: number; width: number; height: number } };
      const inside = reference && r.x >= reference.x && r.y >= reference.y && r.x + r.width <= reference.x + reference.width && r.y + r.height <= reference.y + reference.height;
      return inside ? { width: r.width * reference!.scale, height: r.height * reference!.scale } : null;
    }
    return null;
  }, { shouldMockEvents: true });
});
afterEach(async () => {
  cleanup();
  // 卸载时异步取消事件订阅，等它完成再撤掉模拟。
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});
const sent = (name: string) => calls.filter((c) => c.cmd === `plugin:desktop|${name}`).map((c) => c.args);

async function open() {
  const { container } = render(<CaptureOverlay />);
  const image = await screen.findByAltText("");
  return { root: container.querySelector<HTMLElement>(".capture")!, image };
}
/** Drag from (x0, y0) to (x1, y1) in CSS pixels. */
function select(root: HTMLElement, [x0, y0]: number[], [x1, y1]: number[]) {
  root.setPointerCapture = () => {};
  fireEvent.pointerDown(root, { pointerId: 1, button: 0, clientX: x0, clientY: y0 });
  fireEvent.pointerMove(root, { pointerId: 1, clientX: x1, clientY: y1 });
  fireEvent.pointerUp(root, { pointerId: 1, clientX: x1, clientY: y1 });
}

describe("截图框选（#98 dock）", () => {
  it("没有选区时只有 25% 遮罩与提示；冻结屏幕载入后报告就绪", async () => {
    const { root, image } = await open();
    expect(root.querySelector(".capture-shade")).not.toBeNull();
    expect(image.className).toBe("capture-screen");
    expect(image.style.width).toBe("1920px");
    expect(screen.getByText("拖动框选 · 右键取消")).toBeTruthy();
    expect(screen.queryByRole("toolbar")).toBeNull();
    fireEvent.load(image);
    expect(sent("capture_ready")).toEqual([{ token: "tok" }]);
  });

  it("选区下方的 dock 读出屏幕像素，只有复制、钉住、取消", async () => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    expect(root.querySelector(".capture-shade")).toBeNull();
    const dock = screen.getByRole("toolbar", { name: "截图" });
    expect(within(dock).getByText("125 × 100")).toBeTruthy();
    expect(within(dock).getByText("屏幕像素")).toBeTruthy();
    expect(within(dock).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["复制，Ctrl C", "钉住，Enter", "取消，Esc"]);
    expect(within(dock).getByRole("button", { name: /^钉住/ }).className).toContain("is-primary");
    expect(within(dock).getByRole("button", { name: /^取消/ }).className).toContain("is-danger");
    expect(root.querySelectorAll(".capture-handle")).toHaveLength(4);
  });

  it("拖到显示器右下角时选区补到边缘：框选窗口让出了最下面一行，那一行照样能截到（#230）", async () => {
    const { root } = await open();
    // 冻结屏幕 2400×1500 物理像素，1.25 倍：指针最多到 (2399, 1499)，即 CSS (1919.2, 1199.2)。
    select(root, [100, 80], [1919.2, 1199.2]);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(sent("finish_capture")).toEqual([{ region: { x: 125, y: 100, width: 2275, height: 1400 }, action: "pin", token: "tok" }]);
  });

  it.each([
    ["复制", "copy"], ["钉住", "pin"],
  ] as const)("点 dock 的%s与快捷键发出同一个结束请求", async (label, action) => {
    let { root } = await open();
    select(root, [100, 80], [200, 160]);
    const region = { x: 125, y: 100, width: 125, height: 100 };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) })); });
    cleanup();
    ({ root } = await open());
    select(root, [100, 80], [200, 160]);
    if (action === "copy") fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    else fireEvent.keyDown(window, { key: "Enter" });
    expect(sent("finish_capture")).toEqual([{ region, action, token: "tok" }, { region, action, token: "tok" }]);
  });

  it("取消、Esc、右键都只取消；在 dock 上按下不会开始新选区", async () => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    const cancel = screen.getByRole("button", { name: /^取消/ });
    fireEvent.pointerDown(cancel, { pointerId: 2, button: 0, clientX: 150, clientY: 200 });
    fireEvent.pointerMove(root, { pointerId: 2, clientX: 400, clientY: 400 });
    expect(within(screen.getByRole("toolbar", { name: "截图" })).getByText("125 × 100")).toBeTruthy();
    fireEvent.click(cancel);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(root, { pointerId: 3, button: 2, clientX: 10, clientY: 10 });
    expect(sent("cancel_capture")).toEqual([{ token: "tok" }, { token: "tok" }, { token: "tok" }]);
    expect(sent("finish_capture")).toEqual([]);
  });

  it("聚焦在 dock 按钮上按 Enter 只执行那个按钮", async () => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    const copy = screen.getByRole("button", { name: /^复制/ });
    copy.focus();
    fireEvent.keyDown(copy, { key: "Enter" });
    expect(sent("finish_capture")).toEqual([]);
  });
});

describe("截图读数区分原始像素（#103）", () => {
  const readout = () => within(screen.getByRole("toolbar", { name: "截图" })).getByText(/像素$/).closest(".k-dock-readout") as HTMLElement;
  const star = () => readout().querySelector<SVGSVGElement>("svg.k-original-star");

  it("选区完全落在参考图上时读原图对应区域的原始像素，并带上 logo 的星", async () => {
    // 一张 4 倍缩小显示的参考图，冻结屏幕 (100, 50) 起 600×400（物理像素）。
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    expect(sent("capture_readout")).toContainEqual({ region: { x: 125, y: 100, width: 125, height: 100 }, token: "tok" });
    expect(await within(readout()).findByText("原始像素")).toBeTruthy();
    expect(within(readout()).getByText("500 × 400")).toBeTruthy();
    expect(within(readout()).queryByText("屏幕像素")).toBeNull();
    const mark = star()!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector("path")!.getAttribute("d")).toBe("M132 32 C136.16 53.84 136.16 53.84 158 58 C136.16 62.16 136.16 62.16 132 84 C127.84 62.16 127.84 62.16 106 58 C127.84 53.84 127.84 53.84 132 32 Z");
    expect(mark.querySelector("path")!.getAttribute("fill")).toBe("#E3B34F");
    // 星紧跟“原始像素”最后一个字，挂在它的右上角。
    expect(mark.parentElement!.textContent).toBe("原始像素");
    expect(mark.parentElement!.lastChild).toBe(mark);
  });

  it("跨出图片、盖住多张图或落在遮蔽图上（未登记为来源）时读屏幕像素，无星", async () => {
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    const { root } = await open();
    select(root, [500, 300], [700, 400]);
    await act(async () => {});
    expect(within(readout()).getByText("250 × 125")).toBeTruthy();
    expect(within(readout()).getByText("屏幕像素")).toBeTruthy();
    expect(star()).toBeNull();
  });

  it("选区重新框到图内或图外时读数当场切换，旧的回复不会盖住新选区", async () => {
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    expect(await within(readout()).findByText("原始像素")).toBeTruthy();
    select(root, [500, 300], [700, 400]);
    expect(await within(readout()).findByText("屏幕像素")).toBeTruthy();
    expect(within(readout()).getByText("250 × 125")).toBeTruthy();
    expect(star()).toBeNull();
    select(root, [100, 80], [200, 160]);
    expect(await within(readout()).findByText("原始像素")).toBeTruthy();
    expect(star()).not.toBeNull();
  });

  it("切到原始像素时星从 0 以弹簧放大并轻转落定；减少动画时直接出现", async () => {
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    let { root } = await open();
    select(root, [100, 80], [200, 160]);
    await within(readout()).findByText("原始像素");
    expect(star()!.style.transform).toMatch(/scale\(0\)/);
    expect(star()!.style.transform).toMatch(/rotate\(-15deg\)/);
    cleanup();
    reduced = true;
    ({ root } = await open());
    select(root, [100, 80], [200, 160]);
    await within(readout()).findByText("原始像素");
    expect(star()!.style.transform).not.toMatch(/scale\(0\)|rotate/);
  });
});

describe("框选窗口用完只隐藏，下一次复用（#129）", () => {
  it("会话结束时丢掉冻结屏幕与选区；下一次会话载入新的冻结屏幕，报告新的就绪", async () => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    expect(screen.getByRole("toolbar", { name: "截图" })).toBeTruthy();
    frozen = null;
    await act(async () => { await emit("capture-session"); });
    expect(screen.queryByAltText("")).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    frozen = { image: "screen/tok2", width: 2400, height: 1500 };
    await act(async () => { await emit("capture-session"); });
    const image = await screen.findByAltText("");
    expect(image.getAttribute("src")).toContain("tok2");
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByText("拖动框选 · 右键取消")).toBeTruthy();
    fireEvent.load(image);
    expect(sent("capture_ready")).toEqual([{ token: "tok2" }]);
  });

  it("上一次会话的原始像素读数不带到下一次的同一选区上", async () => {
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    let { root } = await open();
    select(root, [100, 80], [200, 160]);
    await within(screen.getByRole("toolbar", { name: "截图" })).findByText("原始像素");
    reference = null;
    frozen = { image: "screen/tok2", width: 2400, height: 1500 };
    await act(async () => { await emit("capture-session"); });
    await screen.findByAltText("");
    root = document.querySelector<HTMLElement>(".capture")!;
    select(root, [100, 80], [200, 160]);
    expect(within(screen.getByRole("toolbar", { name: "截图" })).queryByText("原始像素")).toBeNull();
  });
});

describe("确认后立刻显示进度，结果可用才关（#127）", () => {
  it("复制原图时 dock 换成“正在复制原图…”，按钮停用，不再接受第二次确认、取消或新选区", async () => {
    reference = { x: 100, y: 50, width: 600, height: 400, scale: 4 };
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    await within(screen.getByRole("toolbar", { name: "截图" })).findByText("原始像素");
    await act(async () => { fireEvent.keyDown(window, { key: "c", ctrlKey: true }); });
    const dock = screen.getByRole("toolbar", { name: "截图" });
    expect(within(dock).getByRole("status").textContent).toBe("正在复制原图…");
    expect(within(dock).getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(root.className).toContain("is-busy");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(root, { pointerId: 4, button: 2, clientX: 10, clientY: 10 });
    select(root, [300, 300], [400, 400]);
    expect(sent("finish_capture")).toHaveLength(1);
    expect(sent("cancel_capture")).toEqual([]);
    expect(within(screen.getByRole("toolbar", { name: "截图" })).getByRole("status")).toBeTruthy();
  });

  it("屏幕截图钉住时显示“正在钉住…”；原生端结束会话后进度消失", async () => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    await act(async () => { fireEvent.keyDown(window, { key: "Enter" }); });
    expect(within(screen.getByRole("toolbar", { name: "截图" })).getByRole("status").textContent).toBe("正在钉住…");
    frozen = null;
    await act(async () => { await emit("capture-session"); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(root.isConnected).toBe(false);
  });
});
