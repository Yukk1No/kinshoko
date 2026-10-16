import { describe, expect, it } from "vitest";
import type { SavedPin } from "../bindings/SavedPin";
import { VEILED_SOURCE_PX, pinSourceRect, pinSourceSize } from "./renderer";

// 钉图渲染器的源图选择（#65）：缩小时以 Rust 派生图为源，局部的边界始终是原图像素。

function reference(scale: number, crop: SavedPin["crop"] = null): SavedPin {
  return {
    id: "P1",
    content: { kind: "reference", libraryId: "L1", imageId: "I1", sourceWidth: 800, sourceHeight: 600 },
    crop,
    width: crop?.width ?? 800,
    height: crop?.height ?? 600,
    placement: { x: 0, y: 0, scale, flipH: false, flipV: false, rotation: 0 },
    opacity: 1,
    locked: false,
  };
}

const capture: SavedPin = {
  ...reference(0.5),
  content: { kind: "capture", captureId: "C1" },
};

describe("钉图的源图", () => {
  it("不缩小时用 1:1 显示的文件（原图或 sdr 派生图）", () => {
    expect(pinSourceSize(reference(1), false)).toBe("full");
    expect(pinSourceSize(reference(2.5), false)).toBe("full");
  });

  it("缩小时用整张缩到钉图尺寸的派生图", () => {
    expect(pinSourceSize(reference(0.5), false)).toBe(400);
    expect(pinSourceSize(reference(0.25, { x: 100, y: 50, width: 300, height: 200 }), false)).toBe(200);
    expect(pinSourceSize(reference(0.001), false)).toBe(1);
  });

  it("缩得几乎不变时仍用派生图，不交给 Chromium 缩小", () => {
    expect(pinSourceSize(reference(0.999), false)).toBe(799);
  });

  it("遮蔽时只取很小的派生图", () => {
    expect(pinSourceSize(reference(1), true)).toBe(VEILED_SOURCE_PX);
    expect(pinSourceSize(reference(0.01), true)).toBe(8);
  });

  it("截图钉图总是画截图本身", () => {
    expect(pinSourceSize(capture, false)).toBe("full");
  });
});

describe("局部在源图上的位置", () => {
  it("整图钉图画整张源图", () => {
    expect(pinSourceRect(reference(0.5), { width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("1:1 源图上就是原图像素的局部", () => {
    const crop = { x: 100, y: 50, width: 300, height: 200 };
    expect(pinSourceRect(reference(1, crop), { width: 800, height: 600 })).toEqual(crop);
  });

  it("派生图上按派生图与原图的比例换算", () => {
    const crop = { x: 100, y: 50, width: 300, height: 200 };
    expect(pinSourceRect(reference(0.5, crop), { width: 400, height: 300 })).toEqual({
      x: 50,
      y: 25,
      width: 150,
      height: 100,
    });
  });

  it("截图钉图的局部按截图像素", () => {
    const crop = { x: 10, y: 5, width: 60, height: 40 };
    expect(pinSourceRect({ ...capture, crop }, { width: 800, height: 600 })).toEqual(crop);
  });
});
