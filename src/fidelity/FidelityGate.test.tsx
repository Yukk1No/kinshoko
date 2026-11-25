import { afterEach, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { GateItem } from "../bindings/GateItem";
import { fakeBackend } from "../test/backend";
import { FidelityGate } from "./FidelityGate";

const item: GateItem = {
  imageId: "sample",
  sha256: "sha256",
  width: 2,
  height: 2,
  display: "original",
  fileName: "sample.png",
  group: "group",
  note: "note",
  gated: true,
  patches: [],
};

const createObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function restoreUrlStatic(name: "createObjectURL" | "revokeObjectURL", descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(URL, name, descriptor);
  else delete (URL as unknown as Record<string, unknown>)[name];
}

afterEach(() => {
  restoreUrlStatic("createObjectURL", createObjectURL);
  restoreUrlStatic("revokeObjectURL", revokeObjectURL);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("一路解码失败时，已创建的 Object URL 仍随卸载回收（#716）", async () => {
  let nextUrl = 0;
  const create = vi.fn(() => `blob:gate-${++nextUrl}`);
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revoke });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (blob: Blob) => {
      if (blob.size === 1) throw new Error("bad thumbnail");
      return { width: 2, height: 2, close: vi.fn() };
    }),
  );
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    })),
    getContextAttributes: vi.fn(() => ({ colorSpace: "display-p3" })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  const fake = fakeBackend({
    gate_plan: { items: [item], environment: {}, library: "D:/samples", autoSave: false },
    gate_image: (args) => ((args.what as string) === "thumbnail" ? [0] : [1, 2, 3, 4]),
    gate_pins: { adapter: "gpu", display: "display", items: [], error: null },
  });

  const view = render(<FidelityGate />);
  await waitFor(() => expect(fake.calls("gate_pins")).toHaveLength(1));
  expect(create).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:gate-1");
});
