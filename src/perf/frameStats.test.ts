import { describe, expect, it } from "vitest";
import { estimateRefresh, percentile, summarizeFrames } from "./frameStats";

const steady = (count: number, interval: number, start = 0) =>
  Array.from({ length: count + 1 }, (_, i) => start + i * interval);

describe("percentile", () => {
  it("按最近秩取值", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
  });
  it("空样本为 null", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("estimateRefresh", () => {
  it("取间隔中位数，偶发长帧不影响", () => {
    const stamps = steady(60, 1000 / 170);
    stamps.push(stamps.at(-1)! + 50);
    expect(estimateRefresh(stamps)).toBeCloseTo(1000 / 170, 3);
  });
  it("样本不足时为 null", () => {
    expect(estimateRefresh([0])).toBeNull();
  });
});

describe("summarizeFrames", () => {
  it("稳定 60 Hz 时没有掉帧并通过合格线", () => {
    const report = summarizeFrames(steady(600, 1000 / 60), { refreshMs: 1000 / 60 });
    expect(report.frames).toBe(600);
    expect(report.p50).toBeCloseTo(16.67, 1);
    expect(report.p95).toBeCloseTo(16.67, 1);
    expect(report.droppedFrames).toBe(0);
    expect(report.dropRate).toBe(0);
    expect(report.pass).toEqual({ p95: true, p99: true, dropRate: true, all: true });
  });

  it("按显示器刷新间隔数掉帧：一次 3 个刷新间隔的帧算掉 2 帧", () => {
    const refresh = 1000 / 170;
    const stamps = steady(97, refresh);
    stamps.push(stamps.at(-1)! + refresh * 3);
    stamps.push(stamps.at(-1)! + refresh);
    stamps.push(stamps.at(-1)! + refresh);
    const report = summarizeFrames(stamps, { refreshMs: refresh });
    expect(report.frames).toBe(100);
    expect(report.droppedFrames).toBe(2);
    expect(report.expectedFrames).toBe(102);
    expect(report.dropRate).toBeCloseTo(2 / 102, 6);
    expect(report.max).toBeCloseTo(refresh * 3, 6);
  });

  it("合格线另按 60 Hz 帧预算计掉帧，170 Hz 结果只记录", () => {
    const refresh = 1000 / 170;
    // 每帧 2 个 170 Hz 间隔（≈11.8 ms）：170 Hz 下一半掉帧，60 Hz 预算内不掉。
    const report = summarizeFrames(steady(200, refresh * 2), { refreshMs: refresh });
    expect(report.dropRate).toBeCloseTo(0.5, 6);
    expect(report.dropRate60).toBe(0);
    expect(report.p95).toBeLessThan(16.7);
    expect(report.pass.all).toBe(true);
    expect(report.atRefresh.p95Budget).toBeCloseTo(refresh, 6);
    expect(report.atRefresh.p95Pass).toBe(false);
  });

  it("超过 p95／p99／掉帧合格线时逐项判为不合格", () => {
    const stamps = steady(90, 1000 / 60);
    for (let i = 0; i < 10; i++) stamps.push(stamps.at(-1)! + 40);
    const report = summarizeFrames(stamps, { refreshMs: 1000 / 60 });
    expect(report.p95).toBeCloseTo(40, 6);
    expect(report.p99).toBeCloseTo(40, 6);
    expect(report.pass).toEqual({ p95: false, p99: false, dropRate: false, all: false });
  });

  it("长任务原样列出，并给出合计", () => {
    const report = summarizeFrames(steady(10, 16), {
      refreshMs: 16,
      longTasks: [
        { kind: "longtask", start: 12.5, duration: 80, name: "self" },
        { kind: "long-animation-frame", start: 100, duration: 120, name: "", scripts: [{ source: "Wall.tsx", duration: 90 }] },
      ],
    });
    expect(report.longTasks).toHaveLength(2);
    expect(report.longTaskTotal).toBe(200);
    expect(report.longTasks[1].scripts?.[0].source).toBe("Wall.tsx");
  });

  it("没有帧时数值为 null，不判合格", () => {
    const report = summarizeFrames([], { refreshMs: 16 });
    expect(report.frames).toBe(0);
    expect(report.p95).toBeNull();
    expect(report.pass.all).toBe(false);
  });
});
