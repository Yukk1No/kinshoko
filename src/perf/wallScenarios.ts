// #102 T7：图片墙的脚本化滚动／缩放场景。每次从顶部开始、按固定时间表驱动，结果可重复比较。
//
// 驱动方式：滚动场景每个 rAF 按时间表直接写 scrollTop（主线程滚动），量的是图片墙随滚动重新挂载、
// 布局与绘制的帧时间；它不经过合成器的滚轮路径，也不量滚轮输入到首帧的延迟——这两项用
// WebView2 performance trace 加真实滚轮另测（见 docs/implementation/spec-102-t07.md）。

import { BUDGET, estimateRefresh, summarizeFrames, type FrameReport } from "./frameStats";
import { browserEnv, createFrameProbe, type ProbeEnv } from "./frameProbe";

export const PROBE_VERSION = 1;

export const SCENARIOS = {
  "wheel-steady": {
    description: "匀速滚轮：向下每秒 1000 像素，连续 10 秒",
    durationMs: 10_000,
    pxPerSecond: 1000,
  },
  "wheel-burst": {
    description: "快速连续滚动：每组 8 格（每格 100 像素、间隔 25 ms），组间停 175 ms，连续 10 秒",
    durationMs: 10_000,
    notchPx: 100,
    notchMs: 25,
    notchesPerBurst: 8,
    burstMs: 350,
  },
  "ctrl-wheel-zoom": {
    description: "Ctrl+滚轮连续缩放一次：光标在图片墙中央，放大 10 格再缩小 10 格，每格间隔 50 ms",
    notches: 10,
    notchMs: 50,
    /** 最后一格后继续记录：覆盖 220 ms 后的提交与按新尺寸重新取缩略图。 */
    tailMs: 1500,
  },
} as const;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_ORDER: ScenarioName[] = ["wheel-steady", "wheel-burst", "ctrl-wheel-zoom"];

/** 场景开始后 elapsed 毫秒时，相对起点应滚到的距离（像素）。纯函数，同一时刻总是同一位置。 */
export function scrollOffset(name: "wheel-steady" | "wheel-burst", elapsed: number): number {
  if (name === "wheel-steady") {
    const s = SCENARIOS["wheel-steady"];
    return Math.round((Math.min(elapsed, s.durationMs) * s.pxPerSecond) / 1000);
  }
  const s = SCENARIOS["wheel-burst"];
  const t = Math.min(elapsed, s.durationMs);
  const bursts = Math.floor(t / s.burstMs);
  const inBurst = Math.min(s.notchesPerBurst, Math.floor((t % s.burstMs) / s.notchMs) + 1);
  return (bursts * s.notchesPerBurst + inBurst) * s.notchPx;
}

/** #102 的 Ctrl+滚轮步进：每格 ×1.1 取整到 10，范围 140–420；in 为变大。 */
export function zoomSteps(start: number, notches: number, direction: "in" | "out"): number[] {
  const out: number[] = [];
  let value = start;
  for (let i = 0; i < notches; i++) {
    const next = direction === "in" ? value * 1.1 : value / 1.1;
    value = Math.min(420, Math.max(140, Math.round(next / 10) * 10));
    out.push(value);
  }
  return out;
}

/** 视口内的卡片中，缩略图还没解码出来的有几张。 */
export function thumbnailGaps(wall: HTMLElement): { visible: number; pending: number } {
  const view = wall.getBoundingClientRect();
  let visible = 0;
  let pending = 0;
  wall.querySelectorAll<HTMLElement>(".card").forEach((card) => {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= view.top || rect.top >= view.bottom) return;
    visible++;
    const img = card.querySelector("img");
    if (!img || !img.complete || img.naturalWidth === 0) pending++;
  });
  return { visible, pending };
}

export type ScenarioResult = {
  name: ScenarioName;
  description: string;
  /** scroll-top：按时间表写 scrollTop；ctrl-wheel：图片墙处理了合成的 Ctrl+滚轮；density-slider：墙不处理时退回驱动图片大小滑条。 */
  driver: "scroll-top" | "ctrl-wheel" | "density-slider";
  durationMs: number;
  scrolledPx: number;
  frames: FrameReport;
  /** 每 250 ms 采样一次视口内缺缩略图的比例。 */
  thumbnails: { samples: number; meanPendingRatio: number | null; worstPendingRatio: number | null } | null;
};

export type WallPerfReport = {
  probeVersion: number;
  startedAt: string;
  environment: {
    userAgent: string;
    devicePixelRatio: number;
    screen: { width: number; height: number };
    viewport: { width: number; height: number };
    refreshMs: number;
    refreshHz: number;
    total: number | null;
    density: number | null;
  };
  budget: typeof BUDGET;
  scenarios: ScenarioResult[];
  warnings: string[];
};

export type RunOptions = {
  env?: ProbeEnv;
  only?: ScenarioName[];
  /** 覆盖滚动场景时长（测试用）；正式基线用默认 10 秒。 */
  durationMs?: number;
  settleMs?: number;
  calibrateMs?: number;
  /** 采样缩略图缺口（会读布局，追求最干净的 trace 时可关）。 */
  sampleThumbnails?: boolean;
};

const nextFrame = (env: ProbeEnv) => new Promise<number>((resolve) => env.raf(resolve));

async function wait(env: ProbeEnv, ms: number) {
  const until = env.now() + ms;
  while (env.now() < until) await nextFrame(env);
}

function findWall(): HTMLElement {
  const wall = document.querySelector<HTMLElement>(".wall");
  if (!wall) throw new Error("找不到图片墙（.wall）。先在主窗口打开资料库的“全部”范围。");
  return wall;
}

const densityInput = () => document.querySelector<HTMLInputElement>(".density input[type=range]");

function setSlider(input: HTMLInputElement, value: number) {
  // React 的受控 range 读原生 setter 写入的值，再由冒泡的 input 事件触发 onChange。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function ctrlWheel(wall: HTMLElement, deltaY: number): boolean {
  const rect = wall.getBoundingClientRect();
  const event = new WheelEvent("wheel", {
    deltaY, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  });
  wall.dispatchEvent(event);
  return event.defaultPrevented;
}

function summarizeGaps(samples: { visible: number; pending: number }[]) {
  const ratios = samples.filter((s) => s.visible > 0).map((s) => s.pending / s.visible);
  return {
    samples: samples.length,
    meanPendingRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    worstPendingRatio: ratios.length ? Math.max(...ratios) : null,
  };
}

async function runScroll(name: "wheel-steady" | "wheel-burst", wall: HTMLElement, env: ProbeEnv, refreshMs: number, o: Required<Omit<RunOptions, "env" | "only">>, durationOverride: number | undefined): Promise<ScenarioResult> {
  const duration = durationOverride ?? SCENARIOS[name].durationMs;
  const probe = createFrameProbe(env);
  const gaps: { visible: number; pending: number }[] = [];
  probe.start();
  const start = env.now();
  let lastSample = -Infinity;
  for (;;) {
    const t = await nextFrame(env);
    const elapsed = t - start;
    if (o.sampleThumbnails && elapsed - lastSample >= 250) {
      lastSample = elapsed;
      gaps.push(thumbnailGaps(wall));
    }
    wall.scrollTop = scrollOffset(name, elapsed);
    if (elapsed >= duration) break;
  }
  const capture = probe.stop();
  return {
    name,
    description: SCENARIOS[name].description,
    driver: "scroll-top",
    durationMs: env.now() - start,
    scrolledPx: wall.scrollTop,
    frames: summarizeFrames(capture.stamps, { refreshMs, longTasks: capture.longTasks }),
    thumbnails: o.sampleThumbnails ? summarizeGaps(gaps) : null,
  };
}

async function runZoom(wall: HTMLElement, env: ProbeEnv, refreshMs: number): Promise<ScenarioResult> {
  const s = SCENARIOS["ctrl-wheel-zoom"];
  const slider = densityInput();
  const initial = slider ? Number(slider.value) : 240;
  const plan = [...zoomSteps(initial, s.notches, "in")];
  plan.push(...zoomSteps(plan.at(-1)!, s.notches, "out"));
  const probe = createFrameProbe(env);
  probe.start();
  const start = env.now();
  let driver: ScenarioResult["driver"] | null = null;
  for (let i = 0; i < plan.length; i++) {
    const deltaY = i < s.notches ? -100 : 100;
    if (driver === null) driver = ctrlWheel(wall, deltaY) ? "ctrl-wheel" : "density-slider";
    else if (driver === "ctrl-wheel") ctrlWheel(wall, deltaY);
    if (driver === "density-slider") {
      if (!slider) throw new Error("图片墙没有处理 Ctrl+滚轮，也找不到图片大小滑条。");
      setSlider(slider, plan[i]);
    }
    await wait(env, s.notchMs);
  }
  // 滑条代驱时回到原来的大小，下一次运行从同一密度开始。
  if (driver === "density-slider" && slider && Number(slider.value) !== initial) setSlider(slider, initial);
  await wait(env, s.tailMs);
  const capture = probe.stop();
  return {
    name: "ctrl-wheel-zoom",
    description: s.description,
    driver: driver ?? "density-slider",
    durationMs: env.now() - start,
    scrolledPx: 0,
    frames: summarizeFrames(capture.stamps, { refreshMs, longTasks: capture.longTasks }),
    thumbnails: null,
  };
}

/** 依次运行图片墙场景，返回可直接存档的 JSON 报告。 */
export async function runWallScenarios(options: RunOptions = {}): Promise<WallPerfReport> {
  const env = options.env ?? browserEnv();
  const o = {
    durationMs: options.durationMs ?? 0,
    settleMs: options.settleMs ?? 1000,
    calibrateMs: options.calibrateMs ?? 1000,
    sampleThumbnails: options.sampleThumbnails ?? true,
  };
  const wall = findWall();
  const warnings: string[] = [];
  const totalAttr = wall.dataset.total;
  const total = totalAttr === undefined ? null : Number(totalAttr);
  if (total === null || total < 5000) warnings.push(`当前范围只有 ${total ?? "未知"} 张，基线要求 5000 张的资料库。`);
  const slider = densityInput();

  // 空闲时校准显示器刷新间隔。
  const calibration = createFrameProbe(env);
  calibration.start();
  await wait(env, o.calibrateMs);
  const refreshMs = estimateRefresh(calibration.stop().stamps) ?? BUDGET.frameMs;

  const report: WallPerfReport = {
    probeVersion: PROBE_VERSION,
    startedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      screen: { width: screen.width, height: screen.height },
      viewport: { width: innerWidth, height: innerHeight },
      refreshMs,
      refreshHz: Math.round(1000 / refreshMs),
      total,
      density: slider ? Number(slider.value) : null,
    },
    budget: BUDGET,
    scenarios: [],
    warnings,
  };

  for (const name of options.only ?? SCENARIO_ORDER) {
    wall.scrollTop = 0;
    await wait(env, o.settleMs);
    report.scenarios.push(name === "ctrl-wheel-zoom"
      ? await runZoom(wall, env, refreshMs)
      : await runScroll(name, wall, env, refreshMs, o, options.durationMs));
  }
  wall.scrollTop = 0;
  return report;
}
