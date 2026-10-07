import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinFrame } from "../bindings/PinFrame";

// 钉图窗口的指针手势（#63、#64、#76 UI2）。IPC 用替身；原生 Windows Ink/WinTab 验收见发布检查清单。
const ipc = vi.hoisted(() => ({
  frame: null as ((frame: PinFrame) => void) | null,
  move: vi.fn(() => Promise.resolve()),
  zoom: vi.fn(() => Promise.resolve()),
  turn: vi.fn(() => Promise.resolve()),
  menu: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ipc", () => ({
  captureUrl: () => "unused",
  movePin: ipc.move,
  onPinFrame: (handler: (frame: PinFrame) => void) => {
    ipc.frame = handler;
    return Promise.resolve(() => {});
  },
  onPinNotice: () => Promise.resolve(() => {}),
  pinFrame: () => Promise.resolve(null),
  pinMenu: ipc.menu,
  pinReady: () => Promise.resolve(),
  setPinOpacity: () => Promise.resolve(),
  settlePin: () => Promise.resolve(),
  turnPin: ipc.turn,
  zoomPin: ipc.zoom,
}));

import { PinView } from "./PinView";

type At = { screen: [number, number]; client: [number, number] };

function pointer(type: string, at: At, pointerType = "pen", button = 0) {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId: 1,
    pointerType,
    button,
    screenX: at.screen[0],
    screenY: at.screen[1],
    clientX: at.client[0],
    clientY: at.client[1],
  });
}

function frame(locked = false): PinFrame {
  return {
    pin: {
      id: "P1",
      content: { kind: "capture", captureId: "C1" },
      crop: null,
      width: 300,
      height: 200,
      placement: { x: 80, y: 80, scale: 1, flipH: false, flipV: false, rotation: 0 },
      opacity: 1,
      locked,
    },
    window: { x: 80, y: 80, width: 300, height: 200 },
    content: { x: 80, y: 80, width: 300, height: 200 },
    motion: "jump",
    generation: 0,
  };
}

async function showPin(locked = false): Promise<HTMLDivElement> {
  const { container } = render(<PinView pin="P1" />);
  await act(async () => {
    await Promise.resolve();
  });
  const host = container.querySelector<HTMLDivElement>(".pin")!;
  host.setPointerCapture = () => {};
  act(() => ipc.frame!(frame(locked)));
  // 页面已打开超过菜单去重的时间。
  act(() => vi.advanceTimersByTime(1000));
  return host;
}

const hold = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("钉图按住打开菜单", () => {
  it("笔拖动跟随的窗口超过 500 ms 不打开菜单，拖动继续", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }));
    // 原生窗口跟着屏幕位移走，窗口内坐标几乎不变。
    fireEvent(host, pointer("pointermove", { screen: [110, 100], client: [21, 20] }));
    expect(ipc.move).toHaveBeenLastCalledWith("P1", 90, 80);
    hold(500);
    expect(ipc.menu).not.toHaveBeenCalled();
    fireEvent(host, pointer("pointermove", { screen: [130, 100], client: [21, 20] }));
    // 只发最新的一次：上一次 IPC 返回后才发排队中的位置。
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(ipc.move).toHaveBeenLastCalledWith("P1", 110, 80);
  });

  it("拖出去又回到起点的笔划不打开菜单", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }));
    fireEvent(host, pointer("pointermove", { screen: [110, 100], client: [20, 20] }));
    fireEvent(host, pointer("pointermove", { screen: [100, 100], client: [20, 20] }));
    hold(500);
    expect(ipc.menu).not.toHaveBeenCalled();
  });

  it("真正静止的按住打开菜单，之后的移动不再拖动", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }));
    fireEvent(host, pointer("pointermove", { screen: [102, 101], client: [22, 21] }));
    hold(499);
    expect(ipc.menu).not.toHaveBeenCalled();
    hold(1);
    expect(ipc.menu).toHaveBeenCalledTimes(1);
    ipc.move.mockClear();
    fireEvent(host, pointer("pointermove", { screen: [140, 100], client: [60, 20] }));
    expect(ipc.move).not.toHaveBeenCalled();
  });

  it("锁定的钉图：按住打开菜单，移动不拖动", async () => {
    const host = await showPin(true);
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }));
    hold(500);
    expect(ipc.menu).toHaveBeenCalledTimes(1);

    hold(1000);
    ipc.menu.mockClear();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }));
    fireEvent(host, pointer("pointermove", { screen: [120, 100], client: [40, 20] }));
    hold(500);
    expect(ipc.move).not.toHaveBeenCalled();
    expect(ipc.menu).not.toHaveBeenCalled();
  });

  it("笔的侧键按下就打开菜单", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }, "pen", 2));
    expect(ipc.menu).toHaveBeenCalledTimes(1);
  });

  it("鼠标右键打开菜单；鼠标按住不动不打开", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [100, 100], client: [20, 20] }, "mouse"));
    hold(600);
    expect(ipc.menu).not.toHaveBeenCalled();
    fireEvent(host, pointer("pointerup", { screen: [100, 100], client: [20, 20] }, "mouse"));
    fireEvent.contextMenu(host);
    expect(ipc.menu).toHaveBeenCalledTimes(1);
  });
});

describe("钉图快捷键与角落缩放", () => {
  it("H/V 翻转，R/Shift+R 旋转", async () => {
    await showPin();
    fireEvent.keyDown(window, { key: "h" });
    fireEvent.keyDown(window, { key: "V" });
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "R", shiftKey: true });
    expect(ipc.turn.mock.calls).toEqual([
      ["P1", "flipHorizontal"],
      ["P1", "flipVertical"],
      ["P1", "rotateClockwise"],
      ["P1", "rotateCounterClockwise"],
    ]);
  });

  it("按住右下角拖动按屏幕位移缩放，超过 500 ms 也不打开菜单", async () => {
    const host = await showPin();
    fireEvent(host, pointer("pointerdown", { screen: [370, 270], client: [290, 190] }));
    fireEvent(host, pointer("pointermove", { screen: [400, 270], client: [290, 190] }));
    expect(ipc.zoom).toHaveBeenLastCalledWith("P1", 1.1, 80, 80);
    expect(ipc.move).not.toHaveBeenCalled();
    hold(500);
    expect(ipc.menu).not.toHaveBeenCalled();
  });
});
