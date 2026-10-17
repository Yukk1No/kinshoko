// #102 T7：帧时间探针的统计部分。只做纯计算，不碰 DOM，方便单元测试与离线复算。

/** #102 性能验收的合格线（开发机，2560 × 1440 @ 170 Hz）。 */
export const BUDGET = {
  /** 60 Hz 一帧。p95 与掉帧都按它卡口。 */
  frameMs: 1000 / 60,
  p95Ms: 16.7,
  p99Ms: 25,
  dropRate: 0.01,
} as const;

export type LongTask = {
  /** `longtask`（Long Tasks API）或 `long-animation-frame`（LoAF，带脚本归因）。 */
  kind: "longtask" | "long-animation-frame";
  /** 相对探针开始的毫秒数。 */
  start: number;
  duration: number;
  name: string;
  /** LoAF 的脚本归因：来源与耗时，最多几项。 */
  scripts?: { source: string; duration: number; invoker?: string }[];
  /** LoAF：渲染（样式与布局）开始到帧结束的耗时。 */
  renderDuration?: number;
  blockingDuration?: number;
};

export type FrameReport = {
  /** 帧间隔数（时间戳数 − 1）。 */
  frames: number;
  durationMs: number;
  /** 显示器一个刷新间隔（毫秒），统计掉帧用。 */
  refreshMs: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  /** 按显示器刷新率：一帧跨了 n 个刷新间隔就算掉 n − 1 帧。 */
  droppedFrames: number;
  expectedFrames: number;
  dropRate: number;
  /** 按 60 Hz 帧预算（16.7 ms）计的掉帧，合格线用它。 */
  droppedFrames60: number;
  dropRate60: number;
  longTasks: LongTask[];
  longTaskTotal: number;
  pass: { p95: boolean; p99: boolean; dropRate: boolean; all: boolean };
  /** 显示器刷新率下的结果，只记录不卡口（170 Hz 时 p95 ≤ 5.9 ms）。 */
  atRefresh: { p95Budget: number; p95Pass: boolean };
};

/** 最近秩百分位。空样本为 null。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const intervalsOf = (stamps: readonly number[]) => stamps.slice(1).map((t, i) => t - stamps[i]);

/** 由空闲时的 rAF 时间戳估计显示器刷新间隔：取间隔中位数。 */
export function estimateRefresh(stamps: readonly number[]): number | null {
  return percentile(intervalsOf(stamps), 50);
}

/** 一帧跨了几个预算间隔（四舍五入，至少 1）。 */
const spans = (interval: number, budget: number) => Math.max(1, Math.round(interval / budget));

/** 由 rAF 时间戳（毫秒，单调递增）与长任务列表得出一次场景的帧时间报告。 */
export function summarizeFrames(
  stamps: readonly number[],
  options: { refreshMs: number; longTasks?: readonly LongTask[] },
): FrameReport {
  const { refreshMs } = options;
  const intervals = intervalsOf(stamps);
  const durationMs = intervals.reduce((sum, x) => sum + x, 0);
  let droppedFrames = 0;
  let expectedFrames = 0;
  let droppedFrames60 = 0;
  for (const interval of intervals) {
    const n = spans(interval, refreshMs);
    expectedFrames += n;
    droppedFrames += n - 1;
    droppedFrames60 += spans(interval, BUDGET.frameMs) - 1;
  }
  const expectedFrames60 = intervals.length ? Math.max(1, Math.round(durationMs / BUDGET.frameMs)) : 0;
  const dropRate = expectedFrames ? droppedFrames / expectedFrames : 0;
  const dropRate60 = expectedFrames60 ? droppedFrames60 / expectedFrames60 : 0;
  const p50 = percentile(intervals, 50);
  const p95 = percentile(intervals, 95);
  const p99 = percentile(intervals, 99);
  const has = intervals.length > 0;
  const pass = {
    p95: has && p95! <= BUDGET.p95Ms,
    p99: has && p99! <= BUDGET.p99Ms,
    dropRate: has && dropRate60 <= BUDGET.dropRate,
    all: false,
  };
  pass.all = pass.p95 && pass.p99 && pass.dropRate;
  const longTasks = [...(options.longTasks ?? [])];
  return {
    frames: intervals.length,
    durationMs,
    refreshMs,
    p50,
    p95,
    p99,
    max: has ? Math.max(...intervals) : null,
    droppedFrames,
    expectedFrames,
    dropRate,
    droppedFrames60,
    dropRate60,
    longTasks,
    longTaskTotal: longTasks.reduce((sum, t) => sum + t.duration, 0),
    pass,
    atRefresh: { p95Budget: refreshMs, p95Pass: has && p95! <= refreshMs + 0.05 },
  };
}
