// #102 T7：开发模式下在主窗口挂出 window.__kinshokoPerf，供 DevTools 控制台或 WebDriver 调用。
// 只由 main.tsx 在 perfEnabled() 为真时动态导入；发行构建不包含本目录。

import { estimateRefresh, summarizeFrames, type FrameReport } from "./frameStats";
import { browserEnv, createFrameProbe, type ProbeEnv } from "./frameProbe";
import { PROBE_VERSION, SCENARIOS, runWallScenarios, type RunOptions, type WallPerfReport } from "./wallScenarios";

export type RecordReport = { durationMs: number; observed: string[]; frames: FrameReport };

export type KinshokoPerf = {
  version: number;
  scenarios: typeof SCENARIOS;
  /** 运行脚本化场景（默认三项全跑），返回 JSON 报告。 */
  run: (options?: Omit<RunOptions, "env">) => Promise<WallPerfReport>;
  /** 只记录 ms 毫秒，不驱动：配合真实滚轮或 WebView2 trace 手动操作时用。 */
  record: (ms: number, options?: { refreshMs?: number }) => Promise<RecordReport>;
};

export function installPerfProbe(target: Window & { __kinshokoPerf?: KinshokoPerf }, env: ProbeEnv = browserEnv()) {
  const perf: KinshokoPerf = {
    version: PROBE_VERSION,
    scenarios: SCENARIOS,
    run: (options) => runWallScenarios({ ...options, env }),
    async record(ms, options) {
      const probe = createFrameProbe(env);
      probe.start();
      const start = env.now();
      while (env.now() - start < ms) await new Promise((resolve) => env.raf(resolve));
      const capture = probe.stop();
      const refreshMs = options?.refreshMs ?? estimateRefresh(capture.stamps) ?? 1000 / 60;
      return {
        durationMs: env.now() - start,
        observed: capture.observed,
        frames: summarizeFrames(capture.stamps, { refreshMs, longTasks: capture.longTasks }),
      };
    },
  };
  target.__kinshokoPerf = perf;
  return perf;
}
