import { describe, expect, it, vi } from "vitest";
import { masonry } from "./layout";
import { createPrefetcher, mountWindow, prefetchOrder } from "./prefetch";

// #109：挂载范围按块更新；缩略图按滚动方向预取，按距离排优先级。
describe("挂载范围按块更新", () => {
  it("滚动没有越出已挂载的余量时沿用原范围（同一个对象，不触发渲染）", () => {
    const first = mountWindow(null, 2000, 800, 700);
    expect(first.top).toBeLessThanOrEqual(2000 - 700);
    expect(first.bottom).toBeGreaterThanOrEqual(2800 + 700);
    expect(mountWindow(first, 2100, 800, 700)).toBe(first);
    expect(mountWindow(first, 1700, 800, 700)).toBe(first);
  });

  it("越出余量的一半时换到新的块，新范围仍留足余量", () => {
    const first = mountWindow(null, 2000, 800, 700);
    const next = mountWindow(first, 2800, 800, 700);
    expect(next).not.toBe(first);
    expect(next.top).toBeLessThanOrEqual(2800 - 700);
    expect(next.bottom).toBeGreaterThanOrEqual(3600 + 700);
    expect(next.top % 256).toBe(0);
  });

  it("视口变高时重新取范围", () => {
    const first = mountWindow(null, 0, 800, 700);
    expect(mountWindow(first, 0, 1600, 700)).not.toBe(first);
  });
});

describe("预取顺序", () => {
  const layout = masonry(Array.from({ length: 200 }, () => ({ w: 100, h: 100 })), { width: 424, target: 200, gap: 8, pad: 12, capRatio: null });

  it("向下滚时取挂载范围下方的图，近的在前；不取上方", () => {
    const order = prefetchOrder(layout, { top: 0, bottom: 1000 }, 1, 1200);
    expect(order.length).toBeGreaterThan(0);
    const ys = order.map((i) => layout.boxes[i].y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(1000);
    expect(Math.max(...ys)).toBeLessThan(2200);
    ys.forEach((y, k) => { if (k) expect(y).toBeGreaterThanOrEqual(ys[k - 1]); });
  });

  it("向上滚时取上方的图，离视口近的在前", () => {
    const order = prefetchOrder(layout, { top: 3000, bottom: 4000 }, -1, 1200);
    const ys = order.map((i) => layout.boxes[i].y);
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((i) => layout.boxes[i].y + layout.boxes[i].h < 3000)).toBe(true);
    ys.forEach((y, k) => { if (k) expect(y).toBeLessThanOrEqual(ys[k - 1]); });
  });
});

describe("预取队列", () => {
  it("同时最多解码几张；新的请求替换还没开始的旧请求；已取过的不再取", async () => {
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const prefetch = createPrefetcher({ concurrency: 2, load: (url) => { started.push(url); return new Promise<void>((r) => finish.push(r)); } });
    prefetch.want(["a", "b", "c", "d"]);
    expect(started).toEqual(["a", "b"]);
    prefetch.want(["x", "a", "y"]);
    finish.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["a", "b", "x"]);
    finish.shift()!();
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["a", "b", "x", "y"]);
    finish.splice(0).forEach((f) => f());
    await Promise.resolve(); await Promise.resolve();
    prefetch.want(["a", "b", "x", "y"]);
    expect(started).toHaveLength(4);
  });

  it("解码失败也放行下一张；dispose 后不再开始", async () => {
    const load = vi.fn((url: string) => url === "bad" ? Promise.reject(new Error("x")) : Promise.resolve());
    const prefetch = createPrefetcher({ concurrency: 1, load });
    prefetch.want(["bad", "ok"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("ok"));
    prefetch.dispose();
    prefetch.want(["later"]);
    expect(load).not.toHaveBeenCalledWith("later");
  });
});
