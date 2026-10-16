import { afterEach, describe, expect, it } from "vitest";
import type { ProbeEnv } from "./frameProbe";
import { SCENARIOS, runWallScenarios, scrollOffset, thumbnailGaps, zoomSteps } from "./wallScenarios";

describe("scrollOffset", () => {
  it("匀速滚轮：每秒 1000 像素，10 秒", () => {
    expect(SCENARIOS["wheel-steady"].durationMs).toBe(10_000);
    expect(scrollOffset("wheel-steady", 0)).toBe(0);
    expect(scrollOffset("wheel-steady", 500)).toBe(500);
    expect(scrollOffset("wheel-steady", 10_000)).toBe(10_000);
  });

  it("快速连续滚动：每组 8 格（每格 100 像素、间隔 25 ms），组间停 175 ms，10 秒", () => {
    expect(SCENARIOS["wheel-burst"].durationMs).toBe(10_000);
    expect(scrollOffset("wheel-burst", 0)).toBe(100);
    expect(scrollOffset("wheel-burst", 24)).toBe(100);
    expect(scrollOffset("wheel-burst", 25)).toBe(200);
    expect(scrollOffset("wheel-burst", 175)).toBe(800);
    expect(scrollOffset("wheel-burst", 349)).toBe(800);
    expect(scrollOffset("wheel-burst", 350)).toBe(900);
  });

  it("同一时刻总得到同一位置（可重复）", () => {
    const a = [0, 123, 4567, 9999].map((t) => scrollOffset("wheel-burst", t));
    const b = [0, 123, 4567, 9999].map((t) => scrollOffset("wheel-burst", t));
    expect(a).toEqual(b);
  });
});

describe("zoomSteps", () => {
  it("每格 ×1.1 取整到 10，范围 140–420，往上滚变大", () => {
    expect(zoomSteps(240, 6, "in")).toEqual([260, 290, 320, 350, 390, 420]);
    expect(zoomSteps(240, 4, "out")).toEqual([220, 200, 180, 160]);
    expect(zoomSteps(150, 3, "out")).toEqual([140, 140, 140]);
  });
});

describe("thumbnailGaps", () => {
  it("只数视口内还没解码出来的缩略图", () => {
    document.body.innerHTML = `
      <div class="wall"><div class="wall-canvas">
        <div class="card" data-in="1"><img data-complete="1"></div>
        <div class="card" data-in="1"><img data-complete="0"></div>
        <div class="card" data-in="0"><img data-complete="0"></div>
      </div></div>`;
    const wall = document.querySelector<HTMLElement>(".wall")!;
    wall.getBoundingClientRect = () => ({ top: 0, bottom: 100 }) as DOMRect;
    wall.querySelectorAll<HTMLElement>(".card").forEach((card) => {
      const inside = card.dataset.in === "1";
      card.getBoundingClientRect = () => ({ top: inside ? 10 : 500, bottom: inside ? 60 : 600 }) as DOMRect;
      const img = card.querySelector("img")!;
      Object.defineProperty(img, "complete", { value: img.dataset.complete === "1" });
      Object.defineProperty(img, "naturalWidth", { value: img.dataset.complete === "1" ? 10 : 0 });
    });
    expect(thumbnailGaps(wall)).toEqual({ visible: 2, pending: 1 });
  });
});

/** 模拟一台 60 Hz 显示器：每次泵一帧，时钟前进 16.67 ms。 */
function simulatedDisplay(frameMs = 1000 / 60) {
  let t = 0;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];
  let next = 1;
  let stopped = false;
  const pump = () => {
    if (stopped) return;
    t += frameMs;
    const due = queue;
    queue = [];
    due.forEach((f) => f.cb(t));
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  const env: ProbeEnv & { sleep: (ms: number) => Promise<void> } = {
    now: () => t,
    raf: (cb) => { const id = next++; queue.push({ id, cb }); return id; },
    caf: (id) => { queue = queue.filter((f) => f.id !== id); },
    observe: () => ({ types: [], disconnect() {} }),
    sleep: (ms) => new Promise((resolve) => {
      const until = t + ms;
      const wait = () => (t >= until ? resolve() : env.raf(wait));
      wait();
    }),
  };
  return { env, stop: () => { stopped = true; } };
}

function mountWall(total: number) {
  document.body.innerHTML = `
    <label class="density"><input type="range" min="140" max="420" step="10" value="240"></label>
    <div class="wall" data-total="${total}"><div class="wall-canvas" style="height:100000px"></div></div>`;
  const wall = document.querySelector<HTMLElement>(".wall")!;
  Object.defineProperty(wall, "clientHeight", { value: 1000 });
  Object.defineProperty(wall, "scrollHeight", { value: 100_000 });
  wall.getBoundingClientRect = () => ({ top: 0, left: 0, width: 2000, height: 1000, bottom: 1000, right: 2000 }) as DOMRect;
  return wall;
}

describe("runWallScenarios", () => {
  let display: ReturnType<typeof simulatedDisplay> | null = null;
  afterEach(() => { display?.stop(); display = null; });

  it("每个场景从顶部开始，按计划驱动滚动并输出帧时间报告", async () => {
    display = simulatedDisplay();
    const wall = mountWall(5000);
    const positions: number[] = [];
    let top = 0;
    Object.defineProperty(wall, "scrollTop", { get: () => top, set: (v: number) => { top = v; positions.push(v); } });
    const report = await runWallScenarios({
      env: display.env,
      only: ["wheel-steady", "wheel-burst"],
      durationMs: 300,
      settleMs: 50,
      calibrateMs: 200,
    });
    expect(report.environment.total).toBe(5000);
    expect(report.environment.refreshMs).toBeCloseTo(1000 / 60, 3);
    expect(report.scenarios.map((s) => s.name)).toEqual(["wheel-steady", "wheel-burst"]);
    for (const s of report.scenarios) {
      expect(s.frames.frames).toBeGreaterThan(10);
      expect(s.frames.p95).toBeCloseTo(1000 / 60, 3);
      expect(s.frames.dropRate).toBe(0);
      expect(s.scrolledPx).toBeGreaterThan(0);
    }
    // 两个场景都先回到顶部。
    expect(positions.filter((p) => p === 0).length).toBeGreaterThanOrEqual(2);
    expect(report.warnings).toEqual([]);
  });

  it("墙上没有处理 Ctrl+滚轮时退回驱动图片大小滑条，并如实记录", async () => {
    display = simulatedDisplay();
    mountWall(5000);
    const slider = document.querySelector<HTMLInputElement>(".density input")!;
    const seen: string[] = [];
    slider.addEventListener("input", () => seen.push(slider.value));
    const report = await runWallScenarios({ env: display.env, only: ["ctrl-wheel-zoom"], settleMs: 20, calibrateMs: 100 });
    const zoom = report.scenarios[0];
    expect(zoom.name).toBe("ctrl-wheel-zoom");
    expect(zoom.driver).toBe("density-slider");
    expect(seen.slice(0, 6)).toEqual(["260", "290", "320", "350", "390", "420"]);
    expect(seen.at(-1)).toBe("240");
  });

  it("墙处理了 Ctrl+滚轮时只发滚轮事件", async () => {
    display = simulatedDisplay();
    const wall = mountWall(5000);
    const wheels: number[] = [];
    wall.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); wheels.push(e.deltaY); } });
    const slider = document.querySelector<HTMLInputElement>(".density input")!;
    let sliderMoves = 0;
    slider.addEventListener("input", () => sliderMoves++);
    const report = await runWallScenarios({ env: display.env, only: ["ctrl-wheel-zoom"], settleMs: 20, calibrateMs: 100 });
    expect(report.scenarios[0].driver).toBe("ctrl-wheel");
    expect(wheels.filter((d) => d < 0)).toHaveLength(SCENARIOS["ctrl-wheel-zoom"].notches);
    expect(wheels.filter((d) => d > 0)).toHaveLength(SCENARIOS["ctrl-wheel-zoom"].notches);
    expect(sliderMoves).toBe(0);
  });

  it("资料库不足 5000 张或找不到图片墙时给出警告", async () => {
    display = simulatedDisplay();
    mountWall(120);
    const report = await runWallScenarios({ env: display.env, only: [], calibrateMs: 50 });
    expect(report.warnings).toEqual([expect.stringContaining("120")]);
    document.body.innerHTML = "";
    await expect(runWallScenarios({ env: display.env, only: [], calibrateMs: 50 })).rejects.toThrow("图片墙");
  });
});
