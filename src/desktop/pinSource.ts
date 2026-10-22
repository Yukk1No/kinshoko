import type { PinFrame } from "../bindings/PinFrame";
import type { SavedPin } from "../bindings/SavedPin";
import { captureUrl, pinImageUrl } from "../ipc";
import { pinSourceSize } from "./renderer";

/** 画面内容变了才重画 canvas（位置变化只改 CSS 变换）。 */
export function drawKey(pin: SavedPin, source: string): string {
  const p = pin.placement;
  return JSON.stringify([source, pin.width, pin.height, pin.crop, p.scale, p.flipH, p.flipV, p.rotation]);
}

/** 钉图此刻应该画的源图地址：截图本身，或资料库钉图经参考视角的显示文件（#65）。 */
export function sourceUrl(f: PinFrame): string {
  const content = f.pin.content;
  if (content.kind === "capture") return captureUrl(content.captureId);
  return pinImageUrl(f.pin.id, pinSourceSize(f.pin, f.veiled));
}
