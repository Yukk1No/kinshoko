import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { CaptureOverlay } from "./CaptureOverlay";

let reduced = false;
vi.mock("motion/react", async (actual) => ({ ...(await actual<typeof import("motion/react")>()), useReducedMotion: () => reduced }));

let calls: { cmd: string; args: any }[];
/** 冻结时登记的参考图在框选窗口里的范围（物理像素）与原图倍率：选区完全落在里面时读原始像素。 */
let reference: { x: number; y: number; width: number; height: number; scale: number } | null;
beforeEach(() => {
  reduced = false;
  reference = null;
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.25 });
  mockConvertFileSrc("windows");
  calls = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "plugin:desktop|frozen_screen") return { image: "screen/tok", width: 2400, height: 1500 };
    if (cmd === "plugin:desktop|capture_readout") {
      const { region: r } = args as { region: { x: number; y: number; width: number; height: number } };
      const inside = reference && r.x >= reference.x && r.y >= reference.y && r.x + r.width <= reference.x + reference.width && r.y + r.height <= reference.y + reference.height;
      return inside ? { width: r.width * reference!.scale, height: r.height * reference!.scale } : null;
    }
    return null;
  });
});
afterEach(() => { cleanup(); clearMocks(); });
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

  it.each([
    ["复制", "copy"], ["钉住", "pin"],
  ] as const)("点 dock 的%s与快捷键发出同一个结束请求", async (label, action) => {
    const { root } = await open();
    select(root, [100, 80], [200, 160]);
    const region = { x: 125, y: 100, width: 125, height: 100 };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) })); });
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
