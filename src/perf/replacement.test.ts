import { expect, it } from "vitest";
import { summarizeReplacement } from "./replacement";

it("完成延迟与离开视口时仍未完成的区间分开统计，缓存命中记 0（#123）", () => {
  const report = summarizeReplacement([
    { latency: 0, instant: true },
    { latency: 40 },
    { latency: 90 },
    { latency: 250 },
    { abandonedAfter: 60 },
    { abandonedAfter: 300 },
    { pendingFor: 150 },
  ]);
  expect(report).toMatchObject({
    completed: 4, instant: 1, overBudget: 1, p50: 40, p95: 250, max: 250,
    abandoned: 2, abandonedOverBudget: 1, pendingAtEnd: 1, pendingAtEndOverBudget: 1, pass: false,
  });
});

it("进入时已加载、但没完成的区间不算缓存命中", () => {
  const report = summarizeReplacement([
    { latency: 0, instant: true },
    { abandonedAfter: 20, instant: true },
    { pendingFor: 20, instant: true },
  ]);
  expect(report).toMatchObject({ completed: 1, instant: 1 });
});

it("任何一个已完成区间超过门槛都不通过，即使 p95 在门槛内", () => {
  const intervals = [...Array.from({ length: 99 }, () => ({ latency: 10 })), { latency: 1000 }];
  const report = summarizeReplacement(intervals);
  expect(report.p95).toBe(10);
  expect(report.overBudget).toBe(1);
  expect(report.pass).toBe(false);
});

it("全部在门槛内完成、离开前未超时才通过", () => {
  const report = summarizeReplacement([{ latency: 0, instant: true }, { latency: 80 }, { abandonedAfter: 30 }]);
  expect(report.pass).toBe(true);
  expect(summarizeReplacement([]).pass).toBe(true);
});
