// 只检查当前窗口实际使用的基础路径。内置 PNG 与白色像素没有用户文件。
// 这些检查不测 ICC、广色域或缩放还原度；对应质量仍由 fidelity gate 独立测量。
import type { CapabilityCheck } from "./bindings/CapabilityCheck";
import type { RuntimeCapabilities } from "./bindings/RuntimeCapabilities";
import type { SavedPin } from "./bindings/SavedPin";
import { createCanvas2dRenderer } from "./desktop/renderer";

const WHITE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const SAMPLE_PIN: SavedPin = {
  id: "runtime-capability-sample",
  content: { kind: "capture", captureId: "runtime-capability-sample" },
  crop: null, width: 1, height: 1,
  placement: { x: 0, y: 0, scale: 1, flipH: false, flipV: false, rotation: 0 },
  opacity: 1, locked: false,
};

async function checkImageDecode(): Promise<CapabilityCheck> {
  const image = new Image();
  if (typeof image.decode !== "function") return "missing";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    image.src = WHITE_PNG;
    return await Promise.race<CapabilityCheck>([
      image.decode().then(() => image.naturalWidth === 1 && image.naturalHeight === 1 ? "available" : "failed", () => "failed"),
      new Promise<CapabilityCheck>((resolve) => { timer = setTimeout(() => resolve("timedOut"), 5000); }),
    ]);
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    image.removeAttribute("src");
  }
}

function checkPinCanvas(): Pick<RuntimeCapabilities, "canvas2d" | "canvasBuffer"> {
  const renderer = createCanvas2dRenderer();
  if (!renderer) return { canvas2d: "missing", canvasBuffer: "unavailable" };
  try {
    const source = document.createElement("canvas");
    source.width = source.height = 1;
    const ctx = source.getContext("2d");
    if (!ctx) return { canvas2d: "missing", canvasBuffer: "unavailable" };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1, 1);
    renderer.draw({ image: source, width: 1, height: 1 }, SAMPLE_PIN);
    const actual = renderer.element.getContext("2d")?.getImageData(0, 0, 1, 1).data;
    const drawn = actual?.length === 4 && [...actual].every((value) => value === 255);
    return { canvas2d: drawn ? "available" : "failed", canvasBuffer: renderer.colorType };
  } catch {
    return { canvas2d: "failed", canvasBuffer: renderer.colorType };
  }
}

export async function probeRuntime(): Promise<RuntimeCapabilities> {
  const canvas = checkPinCanvas();
  return { imageDecode: await checkImageDecode(), ...canvas };
}
