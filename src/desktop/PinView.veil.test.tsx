import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinFrame } from "../bindings/PinFrame";
import type { PinSource } from "./renderer";

// 资料库钉图的遮蔽与源图（#65、#77 UI-D）。IPC、解码与渲染器用受控替身；原生画面见发布检查清单。
const ipc = vi.hoisted(() => ({
  frame: null as ((frame: PinFrame) => void) | null,
  first: null as PinFrame | null,
}));

vi.mock("../ipc", () => ({
  captureUrl: (address: string) => `capture://${address}`,
  movePin: () => Promise.resolve(),
  onPinFrame: (handler: (frame: PinFrame) => void) => {
    ipc.frame = handler;
    return Promise.resolve(() => {});
  },
  onPinNotice: () => Promise.resolve(() => {}),
  pinFrame: () => Promise.resolve(ipc.first),
  pinImageUrl: (pin: string, size: "full" | number) => `pin/${pin}/${size === "full" ? "full" : `fit-${size}`}`,
  pinMenu: () => Promise.resolve(),
  revealPin: () => Promise.resolve(),
  pinReady: () => Promise.resolve(),
  setPinOpacity: () => Promise.resolve(),
  settlePin: () => Promise.resolve(),
  turnPin: () => Promise.resolve(),
  zoomPin: () => Promise.resolve(),
}));

/** 渲染器画过的源图地址（按顺序）。 */
const drawn = vi.hoisted(() => [] as (string | null)[]);
vi.mock("./renderer", async (actual) => ({
  ...(await actual<typeof import("./renderer")>()),
  createCanvas2dRenderer: () => ({
    element: document.createElement("canvas"),
    draw: (source: PinSource | null) => drawn.push(source ? (source.image as HTMLImageElement).getAttribute("src") : null),
  }),
}));

import { PinView } from "./PinView";

/** 还没解码完的源图：地址 → 让解码完成。 */
let decoding: Map<string, () => void>;

function frame(side: number, scale: number, veiled: boolean): PinFrame {
  const size = Math.round(side * scale);
  return {
    pin: {
      id: "P1",
      content: { kind: "reference", libraryId: "L1", imageId: "I1", sourceWidth: side, sourceHeight: side },
      crop: null,
      width: side,
      height: side,
      placement: { x: 0, y: 0, scale, flipH: false, flipV: false, rotation: 0 },
      opacity: 1,
      locked: false,
    },
    window: { x: 0, y: 0, width: size, height: size },
    content: { x: 0, y: 0, width: size, height: size },
    motion: "jump",
    veiled,
    generation: 0,
  };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

async function decode(address: string) {
  const done = decoding.get(address);
  expect(done, `正在解码 ${address}`).toBeTruthy();
  decoding.delete(address);
  done!();
  await flush();
}

/** 打开一张遮蔽中的钉图，并让第一张源图解码完成。 */
async function showVeiled(first: PinFrame, address: string): Promise<HTMLDivElement> {
  ipc.first = first;
  const { container } = render(<PinView pin="P1" />);
  await flush();
  await decode(address);
  const host = container.querySelector<HTMLDivElement>(".pin")!;
  expect(host.classList.contains("pin-veiled")).toBe(true);
  return host;
}

const veiled = (host: HTMLElement) => host.classList.contains("pin-veiled");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
  drawn.length = 0;
  decoding = new Map();
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    return new Promise<void>((resolve) => decoding.set(this.getAttribute("src")!, resolve));
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("资料库钉图的遮蔽（#77 UI-D）", () => {
  it("32 px 的图 1:1 钉住：确认显示后同一源图立即解除遮蔽，再开安全模式时恢复遮蔽", async () => {
    const host = await showVeiled(frame(32, 1, true), "pin/P1/full");

    // 确认显示：应用壳推来不再遮蔽的帧，源图地址不变。
    act(() => ipc.frame!(frame(32, 1, false)));
    expect(veiled(host)).toBe(false);
    expect(host.querySelector(".pin-veil-lock")).toBeNull();

    act(() => ipc.frame!(frame(32, 1, true)));
    expect(veiled(host)).toBe(true);
    act(() => ipc.frame!(frame(32, 1, false)));
    expect(veiled(host)).toBe(false);
  });

  it("800 px 的图缩到 40 px：关闭安全模式后同一源图立即解除遮蔽，再开时恢复遮蔽", async () => {
    const host = await showVeiled(frame(800, 0.05, true), "pin/P1/fit-40");

    act(() => ipc.frame!(frame(800, 0.05, false)));
    expect(veiled(host)).toBe(false);
    expect(decoding.size).toBe(0);

    act(() => ipc.frame!(frame(800, 0.05, true)));
    expect(veiled(host)).toBe(true);
    act(() => ipc.frame!(frame(800, 0.05, false)));
    expect(veiled(host)).toBe(false);
  });

  it("对照：800 px 的图 1:1 钉住，解除遮蔽后等清晰的原图画好才撤掉遮蔽", async () => {
    const host = await showVeiled(frame(800, 1, true), "pin/P1/fit-64");

    act(() => ipc.frame!(frame(800, 1, false)));
    // 还画着遮蔽时取的小图：保持遮蔽，等原图。
    expect(veiled(host)).toBe(true);
    // 不是变成遮蔽，换源图等缩放停下（SOURCE_IDLE_MS）后再读。
    act(() => vi.advanceTimersByTime(200));
    expect(veiled(host)).toBe(true);
    await decode("pin/P1/full");
    expect(veiled(host)).toBe(false);
    expect(drawn.at(-1)).toBe("pin/P1/full");

    // 再开安全模式：立即遮蔽，并换回小图。
    act(() => ipc.frame!(frame(800, 1, true)));
    expect(veiled(host)).toBe(true);
    await decode("pin/P1/fit-64");
    expect(veiled(host)).toBe(true);
    expect(drawn.at(-1)).toBe("pin/P1/fit-64");
  });
});
