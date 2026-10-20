import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinFrame } from "../bindings/PinFrame";

// 钉图层（#193）：一台显示器上的钉图在同一个窗口里。IPC 用替身。
const ipc = vi.hoisted(() => ({
  layerFrame: null as ((frame: PinFrame) => void) | null,
  pinFrames: new Map<string, (frame: PinFrame) => void>(),
  gone: null as ((pin: string) => void) | null,
  initial: [] as string[],
  /** 有值时 `layerPins` 返回它（测快照晚到）。 */
  snapshot: null as Promise<string[]> | null,
  turn: vi.fn(() => Promise.resolve()),
  raise: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ipc", () => ({
  captureUrl: () => "unused",
  closePin: () => Promise.resolve(),
  layerPins: () => ipc.snapshot ?? Promise.resolve(ipc.initial),
  movePin: () => Promise.resolve(),
  onLayerFrame: (handler: (frame: PinFrame) => void) => {
    ipc.layerFrame = handler;
    return Promise.resolve(() => {});
  },
  onPinFrame: (pin: string, handler: (frame: PinFrame) => void) => {
    ipc.pinFrames.set(pin, handler);
    return Promise.resolve(() => {});
  },
  onPinGone: (handler: (pin: string) => void) => {
    ipc.gone = handler;
    return Promise.resolve(() => {});
  },
  onPinNotice: () => Promise.resolve(() => {}),
  pinFrame: () => Promise.resolve(null),
  pinImageUrl: () => "unused",
  pinMenu: () => Promise.resolve(),
  pinReady: () => Promise.resolve(),
  raisePin: ipc.raise,
  revealPin: () => Promise.resolve(),
  setPinOpacity: () => Promise.resolve(),
  settlePin: () => Promise.resolve(),
  turnPin: ipc.turn,
  zoomPin: () => Promise.resolve(),
}));

import { PinLayer } from "./PinLayer";

function frame(id: string, x: number, z: number): PinFrame {
  return {
    pin: {
      id,
      content: { kind: "capture", captureId: `C-${id}` },
      crop: null,
      width: 300,
      height: 200,
      placement: { x, y: 80, scale: 1, flipH: false, flipV: false, rotation: 0 },
      opacity: 1,
      locked: false,
    },
    window: { x: 0, y: 0, width: 2560, height: 1439 },
    content: { x, y: 80, width: 300, height: 200 },
    motion: "jump",
    veiled: false,
    generation: 1,
    settle: false,
    z,
  };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

/** 钉图在层里的定位框（按出现顺序）。 */
const hosts = (container: HTMLElement) => [...container.querySelectorAll<HTMLDivElement>(".pin")];

function send(f: PinFrame) {
  act(() => {
    ipc.layerFrame!(f);
    ipc.pinFrames.get(f.pin.id)?.(f);
  });
}

beforeEach(() => {
  ipc.initial = [];
  ipc.snapshot = null;
  ipc.pinFrames.clear();
  Element.prototype.setPointerCapture = () => {};
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("钉图层", () => {
  it("画着层里已有的钉图，有帧进来时加上新钉图，离开时去掉", async () => {
    ipc.initial = ["A"];
    const { container } = render(<PinLayer />);
    await flush();
    expect(hosts(container)).toHaveLength(1);
    send(frame("B", 600, 2));
    await flush();
    expect(hosts(container)).toHaveLength(2);
    act(() => ipc.gone!("A"));
    expect(hosts(container)).toHaveLength(1);
  });

  it("取快照期间离开的钉图不会被旧快照加回来", async () => {
    let answer!: (list: string[]) => void;
    ipc.snapshot = new Promise((resolve) => (answer = resolve));
    const { container } = render(<PinLayer />);
    await flush();
    act(() => ipc.gone!("A"));
    answer(["A", "B"]);
    await flush();
    expect(hosts(container)).toHaveLength(1);
  });

  it("上下次序按帧里的 z；按下的钉图请应用壳把它提到最上面", async () => {
    ipc.initial = ["A", "B"];
    const { container } = render(<PinLayer />);
    await flush();
    send(frame("A", 80, 5));
    send(frame("B", 600, 3));
    const [a, b] = hosts(container);
    expect(a.style.zIndex).toBe("5");
    expect(b.style.zIndex).toBe("3");
    fireEvent.pointerDown(b, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 650, clientY: 100 });
    expect(ipc.raise).toHaveBeenCalledWith("B");
  });

  it("快捷键作用在光标下的钉图上", async () => {
    ipc.initial = ["A", "B"];
    const { container } = render(<PinLayer />);
    await flush();
    send(frame("A", 80, 1));
    send(frame("B", 600, 2));
    const content = container.querySelectorAll<HTMLDivElement>(".pin-content");
    fireEvent.pointerEnter(content[0]);
    fireEvent.keyDown(window, { key: "h" });
    expect(ipc.turn).toHaveBeenLastCalledWith("A", "flipHorizontal");
    fireEvent.pointerLeave(content[0]);
    fireEvent.pointerEnter(content[1]);
    fireEvent.keyDown(window, { key: "v" });
    expect(ipc.turn).toHaveBeenLastCalledWith("B", "flipVertical");
  });
});
