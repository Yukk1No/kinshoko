import { describe, expect, it } from "vitest";
import { createFrameProbe, type ProbeEnv } from "./frameProbe";

/** 手动推进的 rAF 与 PerformanceObserver。 */
function fakeEnv(supported: string[] = ["longtask", "long-animation-frame"]) {
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let nextId = 1;
  const observers: { cb: PerformanceObserverCallback; types: string[]; connected: boolean }[] = [];
  const env: ProbeEnv = {
    now: () => 1000,
    raf: (cb) => { const id = nextId++; queue.push({ id, cb }); return id; },
    caf: (id) => { queue = queue.filter((f) => f.id !== id); },
    observe(types, cb) {
      const entry = { cb, types: types.filter((t) => supported.includes(t)), connected: true };
      observers.push(entry);
      return { types: entry.types, disconnect: () => { entry.connected = false; } };
    },
  };
  return {
    env,
    frame(t: number) {
      const due = queue;
      queue = [];
      due.forEach((f) => f.cb(t));
    },
    pending: () => queue.length,
    emit(entries: Partial<PerformanceEntry & Record<string, unknown>>[]) {
      for (const o of observers) {
        if (!o.connected) continue;
        const list = { getEntries: () => entries.filter((e) => o.types.includes(e.entryType as string)) } as unknown as PerformanceObserverEntryList;
        o.cb(list, {} as PerformanceObserver);
      }
    },
  };
}

describe("createFrameProbe", () => {
  it("记录每个 rAF 时间戳，停止后不再请求帧", () => {
    const fake = fakeEnv();
    const probe = createFrameProbe(fake.env);
    probe.start();
    [1000, 1016, 1033, 1050].forEach((t) => fake.frame(t));
    const capture = probe.stop();
    expect(capture.stamps).toEqual([1000, 1016, 1033, 1050]);
    expect(fake.pending()).toBe(0);
    expect(probe.running).toBe(false);
  });

  it("长任务按探针开始时刻换算，LoAF 带上脚本归因", () => {
    const fake = fakeEnv();
    const probe = createFrameProbe(fake.env);
    probe.start();
    fake.emit([
      { entryType: "longtask", startTime: 1100, duration: 70, name: "self" },
      {
        entryType: "long-animation-frame", startTime: 1300, duration: 95, name: "long-animation-frame",
        renderStart: 1370, blockingDuration: 45,
        scripts: [{ sourceURL: "http://x/assets/index.js", sourceFunctionName: "onScroll", invoker: "DIV.onscroll", duration: 60 }],
      },
    ]);
    const capture = probe.stop();
    expect(capture.longTasks).toEqual([
      { kind: "longtask", start: 100, duration: 70, name: "self" },
      {
        kind: "long-animation-frame", start: 300, duration: 95, name: "long-animation-frame",
        renderDuration: 25, blockingDuration: 45,
        scripts: [{ source: "http://x/assets/index.js#onScroll", invoker: "DIV.onscroll", duration: 60 }],
      },
    ]);
    expect(capture.observed).toEqual(["longtask", "long-animation-frame"]);
  });

  it("停止后到达的长任务不再计入；不支持的类型如实记录", () => {
    const fake = fakeEnv(["longtask"]);
    const probe = createFrameProbe(fake.env);
    probe.start();
    const capture = probe.stop();
    fake.emit([{ entryType: "longtask", startTime: 1200, duration: 60, name: "self" }]);
    expect(capture.longTasks).toEqual([]);
    expect(capture.observed).toEqual(["longtask"]);
  });

  it("重复开始时从头记录", () => {
    const fake = fakeEnv();
    const probe = createFrameProbe(fake.env);
    probe.start();
    fake.frame(1000);
    probe.start();
    fake.frame(2000);
    expect(probe.stop().stamps).toEqual([2000]);
  });
});
