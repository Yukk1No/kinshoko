// 图片墙的挂载范围与缩略图预取（#102 故事17，#109）。

import { visible, type Layout } from "./layout";

/** 挂载范围按块对齐（画布像素）。 */
export const MOUNT_CHUNK = 256;

export type MountWindow = { top: number; bottom: number };

/**
 * 应挂载的画布范围 [top, bottom)。视口上下各留 overscan；只要视口上下仍各有 overscan 的一半在范围内，
 * 就返回原来的对象（调用方据此跳过 React 渲染），越出时才换到新的、按块对齐的范围。
 */
export function mountWindow(prev: MountWindow | null, scrollTop: number, height: number, overscan: number): MountWindow {
  const margin = overscan / 2;
  if (prev && prev.top <= scrollTop - margin && prev.bottom >= scrollTop + height + margin) return prev;
  return {
    top: Math.floor((scrollTop - overscan) / MOUNT_CHUNK) * MOUNT_CHUNK,
    bottom: Math.ceil((scrollTop + height + overscan) / MOUNT_CHUNK) * MOUNT_CHUNK,
  };
}

/**
 * 挂载范围之外（与它不相交）、滚动方向前方 distance 像素内的图，离挂载范围近的在前。direction 1 为向下。
 */
export function prefetchOrder(layout: Layout, mounted: MountWindow, direction: 1 | -1, distance: number): number[] {
  if (direction > 0) {
    return visible(layout, mounted.bottom, mounted.bottom + distance)
      .filter((i) => layout.boxes[i].y >= mounted.bottom)
      .sort((a, b) => layout.boxes[a].y - layout.boxes[b].y);
  }
  const bottom = (i: number) => layout.boxes[i].y + layout.boxes[i].h;
  return visible(layout, mounted.top - distance, mounted.top)
    .filter((i) => bottom(i) < mounted.top)
    .sort((a, b) => bottom(b) - bottom(a));
}

/** 浏览器里预取一张缩略图：异步解码，不在主线程同步解码。 */
export function decodeThumbnail(url: string): Promise<unknown> {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  return typeof image.decode === "function" ? image.decode() : Promise.resolve();
}

/**
 * 预取队列：同时最多 concurrency 张；want() 用新的有序清单替换还没开始的请求；
 * 记得最近取过的 remember 个地址，不重复取。
 */
export function createPrefetcher(o: { load?: (url: string) => Promise<unknown>; concurrency?: number; remember?: number } = {}) {
  const load = o.load ?? decodeThumbnail;
  const concurrency = o.concurrency ?? 4;
  const remember = o.remember ?? 1500;
  const done = new Set<string>();
  const running = new Set<string>();
  let queue: string[] = [];
  let disposed = false;
  const pump = () => {
    while (!disposed && running.size < concurrency && queue.length) {
      const url = queue.shift()!;
      if (done.has(url) || running.has(url)) continue;
      running.add(url);
      const settle = () => {
        running.delete(url);
        done.add(url);
        if (done.size > remember) done.delete(done.values().next().value!);
        pump();
      };
      load(url).then(settle, settle);
    }
  };
  return {
    want(urls: readonly string[]) {
      if (disposed) return;
      queue = urls.filter((url) => !done.has(url) && !running.has(url));
      pump();
    },
    dispose() { disposed = true; queue = []; },
  };
}
