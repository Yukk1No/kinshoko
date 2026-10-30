// 只检查当前窗口实际使用的基础路径。内置 PNG 与白色像素没有用户文件。
// 这些检查不测 ICC、广色域或缩放还原度；对应质量仍由 fidelity gate 独立测量。
import type { CapabilityCheck } from "./bindings/CapabilityCheck";
import type { RuntimeCapabilities } from "./bindings/RuntimeCapabilities";

const WHITE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
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

export async function probeRuntime(): Promise<RuntimeCapabilities> {
  return { imageDecode: await checkImageDecode() };
}
