import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureImage, readCaptureFrame } from "./captureSources";

// #216：截图前后主窗口各报告一次可见参考图。每张图都重新遍历整个文档、读一遍所有元素的矩形时，
// 图片墙和侧栏越大越慢；一次报告里所有图共用同一份矩形。
const rects = new Map<Element, DOMRect>();
let reads = 0;
beforeEach(() => {
  rects.clear();
  reads = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    reads += 1;
    return rects.get(this) ?? new DOMRect(0, 0, 0, 0);
  });
  Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 100 });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get: () => 100 });
  // 浮层盖在第一张图的中央，其余位置最上层都是图本身。
  document.elementFromPoint = (x: number, y: number) =>
    x >= 40 && x < 60 && y >= 40 && y < 60 ? document.querySelector(".overlay") : imageAt(x);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  delete (HTMLImageElement.prototype as { complete?: boolean }).complete;
  delete (HTMLImageElement.prototype as { naturalWidth?: number }).naturalWidth;
  delete (HTMLImageElement.prototype as { naturalHeight?: number }).naturalHeight;
});

function imageAt(x: number): Element | null {
  return document.querySelectorAll(".card img")[Math.floor(x / 120)] ?? null;
}

function wall(images: number, filler: number) {
  const clip = document.createElement("div");
  rects.set(clip, new DOMRect(0, 0, 120 * images, 100));
  for (let i = 0; i < images; i++) {
    const card = document.createElement("div");
    card.className = "card";
    const image = document.createElement("img");
    card.append(image);
    clip.append(card);
    rects.set(card, new DOMRect(120 * i, 0, 100, 100));
    rects.set(image, new DOMRect(120 * i, 0, 100, 100));
  }
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  rects.set(overlay, new DOMRect(40, 40, 20, 20));
  const sidebar = document.createElement("nav");
  for (let i = 0; i < filler; i++) sidebar.append(document.createElement("span"));
  document.body.append(clip, overlay, sidebar);
  return { clip, images: [...clip.querySelectorAll("img")] };
}

const read = (clip: HTMLElement, images: HTMLImageElement[]) =>
  images.map((image, i) => captureImage(image, clip, "L1", `i${i}`, 100, 100));

it("一次报告里所有参考图共用同一份元素矩形，读取次数不随图数乘以元素数增长", () => {
  const { clip, images } = wall(20, 500);
  const nodes = document.querySelectorAll("body *").length;
  reads = 0;
  readCaptureFrame(() => read(clip, images));
  // 每张图自己与裁切范围各读一次，加上整页一遍。
  expect(reads).toBeLessThanOrEqual(nodes + images.length * 2);
});

it("共用矩形与逐张读取得到相同的可见范围与遮挡", () => {
  const { clip, images } = wall(5, 10);
  const alone = read(clip, images);
  const shared = readCaptureFrame(() => read(clip, images));
  expect(shared).toEqual(alone);
  expect(shared[0]?.covered).toEqual([{ x: 40, y: 40, width: 20, height: 20 }]);
  expect(shared.slice(1).every((reference) => reference?.covered.length === 0)).toBe(true);
});
