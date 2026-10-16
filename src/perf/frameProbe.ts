// #102 T7：开发模式的帧时间探针。记录 rAF 时间戳与长任务（Long Tasks、LoAF），统计交给 frameStats。

// 启用条件见 src/main.tsx：Vite 开发服务器，或构建时 VITE_KINSHOKO_PERF=1。

import type { LongTask } from "./frameStats";

export type ProbeEnv = {
  now: () => number;
  raf: (cb: FrameRequestCallback) => number;
  caf: (id: number) => void;
  /** 订阅性能条目；返回实际支持的类型。 */
  observe: (types: string[], cb: PerformanceObserverCallback) => { types: string[]; disconnect: () => void };
};

export type FrameCapture = {
  stamps: number[];
  longTasks: LongTask[];
  /** 本次真正订阅到的性能条目类型（WebView 不支持的不会出现）。 */
  observed: string[];
};

export const browserEnv = (): ProbeEnv => ({
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  observe(types, cb) {
    const supported = typeof PerformanceObserver === "undefined" ? [] : types.filter((t) => PerformanceObserver.supportedEntryTypes?.includes(t));
    const observers = supported.map((type) => {
      const observer = new PerformanceObserver(cb);
      observer.observe({ type, buffered: false });
      return observer;
    });
    return { types: supported, disconnect: () => observers.forEach((o) => o.disconnect()) };
  },
});

type LoafScript = { sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration?: number };
type Entry = PerformanceEntry & { renderStart?: number; blockingDuration?: number; scripts?: LoafScript[] };

function toLongTask(entry: Entry, origin: number): LongTask {
  const task: LongTask = {
    kind: entry.entryType === "long-animation-frame" ? "long-animation-frame" : "longtask",
    start: entry.startTime - origin,
    duration: entry.duration,
    name: entry.name,
  };
  if (task.kind === "long-animation-frame") {
    if (entry.renderStart) task.renderDuration = entry.startTime + entry.duration - entry.renderStart;
    if (entry.blockingDuration !== undefined) task.blockingDuration = entry.blockingDuration;
    task.scripts = (entry.scripts ?? []).slice(0, 5).map((s) => ({
      source: `${s.sourceURL ?? ""}${s.sourceFunctionName ? `#${s.sourceFunctionName}` : ""}`,
      ...(s.invoker ? { invoker: s.invoker } : {}),
      duration: s.duration ?? 0,
    }));
  }
  return task;
}

export function createFrameProbe(env: ProbeEnv = browserEnv()) {
  let stamps: number[] = [];
  let longTasks: LongTask[] = [];
  let observed: string[] = [];
  let frame = 0;
  let origin = 0;
  let subscription: { disconnect: () => void } | null = null;
  let running = false;

  const tick: FrameRequestCallback = (t) => {
    if (!running) return;
    stamps.push(t);
    frame = env.raf(tick);
  };

  const halt = () => {
    running = false;
    env.caf(frame);
    subscription?.disconnect();
    subscription = null;
  };

  return {
    get running() { return running; },
    start() {
      halt();
      stamps = [];
      longTasks = [];
      origin = env.now();
      running = true;
      const sub = env.observe(["longtask", "long-animation-frame"], (list) => {
        if (!running) return;
        for (const entry of list.getEntries()) longTasks.push(toLongTask(entry as Entry, origin));
      });
      observed = sub.types;
      subscription = sub;
      frame = env.raf(tick);
    },
    stop(): FrameCapture {
      halt();
      return { stamps, longTasks, observed };
    },
  };
}
