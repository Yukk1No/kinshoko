import { afterEach, describe, expect, it } from "vitest";
import type { ProbeEnv } from "./frameProbe";
import { installPerfProbe, type KinshokoPerf } from "./install";

declare global {
  interface Window { __kinshokoPerf?: KinshokoPerf }
}

function ticking(frameMs: number) {
  let t = 0;
  let queue: FrameRequestCallback[] = [];
  let stopped = false;
  const pump = () => {
    if (stopped) return;
    t += frameMs;
    const due = queue;
    queue = [];
    due.forEach((cb) => cb(t));
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  const env: ProbeEnv = {
    now: () => t,
    raf: (cb) => { queue.push(cb); return queue.length; },
    caf: () => { queue = []; },
    observe: () => ({ types: ["longtask"], disconnect() {} }),
  };
  return { env, stop: () => { stopped = true; } };
}

describe("installPerfProbe", () => {
  let stop = () => {};
  afterEach(() => { stop(); delete window.__kinshokoPerf; });

  it("在 window 上挂出探针入口", () => {
    installPerfProbe(window);
    expect(window.__kinshokoPerf?.version).toBe(1);
    expect(Object.keys(window.__kinshokoPerf!.scenarios)).toEqual(["wheel-steady", "wheel-burst", "ctrl-wheel-zoom"]);
    expect(typeof window.__kinshokoPerf!.run).toBe("function");
  });

  it("record 在给定时长内只记录（手动或真实滚轮操作时用），导出 p50／p95／p99、掉帧率与长任务", async () => {
    const display = ticking(1000 / 120);
    stop = display.stop;
    installPerfProbe(window, display.env);
    const report = await window.__kinshokoPerf!.record(200);
    expect(report.frames.frames).toBeGreaterThan(10);
    expect(report.frames.p50).toBeCloseTo(1000 / 120, 3);
    expect(report.frames).toHaveProperty("p95");
    expect(report.frames).toHaveProperty("p99");
    expect(report.frames).toHaveProperty("dropRate");
    expect(report.frames.longTasks).toEqual([]);
    expect(report.observed).toEqual(["longtask"]);
  });
});
