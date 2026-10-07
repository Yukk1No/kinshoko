// 钉图渲染器（#65）：把源图按 DPI 像素规则画进钉图窗口。可替换的模块——以后换 WebGPU 时
// 只实现 PinRenderer；canvas 2D 是目前唯一的实现。源图的选择（原图、sdr 派生图、缩小的派生图）
// 与局部换算是纯函数，与实现无关。

import type { Region } from "../bindings/Region";
import type { SavedPin } from "../bindings/SavedPin";
import { pinCanvasSize, pinDrawing } from "./pixels";

/** 已解码、可以画的源图。尺寸是源图自己的像素（派生图比原图小）。 */
export interface PinSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** 钉图渲染器：一块装在钉图窗口里的画面。 */
export interface PinRenderer {
  /** 画面元素（放进钉图内容里，遮蔽、透明度由外面的 CSS 做）。 */
  readonly element: HTMLElement;
  /** 按钉图此刻的局部、缩放、翻转与旋转画 source；source 为 null 时画中性灰的占位。 */
  draw(source: PinSource | null, pin: SavedPin): void;
}

/** 遮蔽时只取这么宽的派生图：模糊与墨色罩之下看不出细节，原图像素不必进到钉图窗口。 */
export const VEILED_SOURCE_PX = 64;

/** 原图（资料库钉图）或截图的整张尺寸；截图钉图为 null（源图就是截图本身）。 */
function fullSize(pin: SavedPin): { width: number; height: number } | null {
  return pin.content.kind === "reference"
    ? { width: pin.content.sourceWidth, height: pin.content.sourceHeight }
    : null;
}

/**
 * 钉图要画的源图：`"full"` 为 1:1 显示的文件（原图，或动图、HDR 等的 sdr 派生图）；数字为
 * 整张缩到这个宽度的派生图（物理像素）。缩小时以 Rust 派生图为源，不交给 Chromium 缩小。
 */
export function pinSourceSize(pin: SavedPin, veiled: boolean): "full" | number {
  const full = fullSize(pin);
  if (!full) return "full";
  const scale = pin.placement.scale;
  let px = scale < 1 ? Math.max(1, Math.round(full.width * scale)) : full.width;
  if (veiled) px = Math.min(px, VEILED_SOURCE_PX);
  return px >= full.width ? "full" : px;
}

/** 局部（原图像素）在源图上的位置；整图钉图为整张源图。 */
export function pinSourceRect(pin: SavedPin, source: { width: number; height: number }): Region {
  const full = fullSize(pin) ?? source;
  const crop = pin.crop ?? { x: 0, y: 0, width: full.width, height: full.height };
  const sx = source.width / full.width;
  const sy = source.height / full.height;
  return { x: crop.x * sx, y: crop.y * sy, width: crop.width * sx, height: crop.height * sy };
}

/**
 * 钉图的 2D 画布：sRGB 色彩空间，优先用 float16 后备存储。
 *
 * 在开发机（110%，sRGB 显示器配置文件）上实测：sRGB 画布（8 位或 float16）与 <img> 回显逐像素
 * 一致；display-p3 画布即使是 float16 也有约一半像素偏差 1～8 级，不满足截图恒等，所以不用 P3。
 * float16 的 sRGB 画布是扩展范围的，广色域的图不会被裁到 sRGB 色域；不支持时退回 8 位。
 */
function pinContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const wide = canvas.getContext("2d", {
    colorSpace: "srgb",
    colorType: "float16",
  } as CanvasRenderingContext2DSettings);
  const attributes = wide?.getContextAttributes() as { colorType?: string } | undefined;
  if (wide && attributes?.colorType === "float16") return wide;
  // 同一块 canvas 只能取一次 context，换一块再取普通画布。
  const fallback = document.createElement("canvas");
  fallback.className = canvas.className;
  return fallback.getContext("2d", { colorSpace: "srgb" });
}

/** canvas 2D 实现。浏览器不给 2D context 时为 null。 */
export function createCanvas2dRenderer(): PinRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.className = "pin-canvas";
  const ctx = pinContext(canvas);
  if (!ctx) return null;
  return {
    element: ctx.canvas,
    draw(source, pin) {
      // 按 DPI 像素规则：canvas 后备尺寸等于钉图的物理像素；先翻转再绕中心旋转，只画局部。
      const geometry = { width: pin.width, height: pin.height, ...pin.placement };
      const size = pinCanvasSize(geometry, window.devicePixelRatio);
      const drawing = pinDrawing(geometry);
      const c = ctx.canvas;
      c.width = size.width;
      c.height = size.height;
      c.style.width = `${size.cssWidth}px`;
      c.style.height = `${size.cssHeight}px`;
      c.style.imageRendering = size.pixelated ? "pixelated" : "auto";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      if (!source) {
        ctx.fillStyle = "#8a8a8e";
        ctx.fillRect(0, 0, size.width, size.height);
        return;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.translate(size.width / 2, size.height / 2);
      ctx.rotate(drawing.angle);
      ctx.scale(drawing.flipX, drawing.flipY);
      const from = pinSourceRect(pin, source);
      ctx.drawImage(
        source.image,
        from.x,
        from.y,
        from.width,
        from.height,
        -drawing.width / 2,
        -drawing.height / 2,
        drawing.width,
        drawing.height,
      );
    },
  };
}
