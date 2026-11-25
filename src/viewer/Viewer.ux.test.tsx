import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { type FakeBackend, fakeBackend } from "../test/backend";
import { tipText } from "../test/tip";
import { Viewer } from "./Viewer";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    events.set(name, callback);
    return () => events.delete(name);
  }),
}));

describe("查看器翻转、双击与快捷键", () => {
  const largeCard = { id: "a", width: 2000, height: 1600, thumbnail: "", adult: false };
  const exactCard = { id: "b", width: 800, height: 600, thumbnail: "", adult: false };
  let backend: FakeBackend;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 800));
    mockConvertFileSrc("windows");
    backend = fakeBackend({
      image: {},
      copy_reference_image: null,
      pin_reference: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("H 键与工具栏切换水平翻转，换图后自动复位，翻转态框选正确换算原图坐标", async () => {
    const { rerender } = render(<Viewer libraryId="L1" card={exactCard} onClose={() => {}} />);
    const viewer = screen.getByRole("region", { name: "原图查看器" });
    const flipButton = screen.getByRole("button", { name: /^水平翻转/ });
    const img = () => screen.getByAltText("正在查看的参考图");

    expect(img().getAttribute("data-flipped")).toBeNull();
    expect(flipButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(viewer, { key: "h" });
    expect(img().getAttribute("data-flipped")).toBe("true");
    expect(img().style.transform).toContain("scaleX(-1)");
    expect(flipButton.getAttribute("aria-pressed")).toBe("true");

    // 翻转态在适应窗口居中 (100, 100, 800, 600) 的右侧框选 (800, 110)..(890, 210) -> 原图 x: 10..100
    const stage = img().parentElement!;
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 800, clientY: 110, button: 0, shiftKey: true });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 890, clientY: 210 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    await act(async () => {
      fireEvent.keyDown(stage, { key: "Enter" });
    });
    expect(backend.calls("pin_reference").at(-1)?.args).toMatchObject({
      libraryId: "L1",
      imageId: "b",
      crop: { x: 10, y: 10, width: 90, height: 100 },
    });

    // 换图自动复位翻转状态；再通过工具栏按钮可重新切换。
    rerender(<Viewer libraryId="L1" card={{ ...exactCard, id: "c" }} onClose={() => {}} />);
    expect(img().getAttribute("data-flipped")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^水平翻转/ }));
    expect(img().getAttribute("data-flipped")).toBe("true");
  });

  it("= 与 - 键缩放，工具栏缩放按钮悬停提示带快捷键", async () => {
    render(<Viewer libraryId="L1" card={exactCard} onClose={() => {}} />);
    const viewer = screen.getByRole("region", { name: "原图查看器" });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");

    fireEvent.keyDown(viewer, { key: "=" });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("125%");
    fireEvent.keyDown(viewer, { key: "-" });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");

    expect(await tipText(screen.getByRole("button", { name: "放大" }))).toBe("放大+");
    expect(await tipText(screen.getByRole("button", { name: "缩小" }))).toBe("缩小-");
  });

  it("双击舞台切换适应窗口与 100% 原始像素；框选模式下双击不触发缩放", () => {
    render(<Viewer libraryId="L1" card={largeCard} onClose={() => {}} />);
    const stage = screen.getByAltText("正在查看的参考图").parentElement!;
    expect(screen.getByLabelText("缩放比例").textContent).toBe("50%");

    fireEvent.doubleClick(stage, { clientX: 500, clientY: 400 });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("100%");

    fireEvent.doubleClick(stage, { clientX: 500, clientY: 400 });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("50%");

    fireEvent.click(screen.getByRole("button", { name: /^框选局部/ }));
    fireEvent.doubleClick(stage, { clientX: 500, clientY: 400 });
    expect(screen.getByLabelText("缩放比例").textContent).toBe("50%");
  });

  it("无文字选区时按 Ctrl+C 复制当前参考图", async () => {
    render(<Viewer libraryId="L1" card={exactCard} onClose={() => {}} />);
    const viewer = screen.getByRole("region", { name: "原图查看器" });
    fireEvent.keyDown(viewer, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(backend.calls("copy_reference_image")[0]?.args).toEqual({ libraryId: "L1", imageId: "b" }),
    );
    expect(await screen.findByText("已复制图片")).toBeTruthy();
  });
});
