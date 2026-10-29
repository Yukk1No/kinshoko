import { expect, it } from "vitest";
import { INITIAL_SAFE_LENS, needsRecheck, reduceSafeLens, type SafeLens } from "./safeLens";

const run = (...actions: Parameters<typeof reduceSafeLens>[1][]): SafeLens => actions.reduce(reduceSafeLens, INITIAL_SAFE_LENS);

it("读到设置之前按开启处理：显示与查询都是开", () => {
  expect(INITIAL_SAFE_LENS).toMatchObject({ shown: true, lens: true });
});

it("开启：开关与查询视角当即都变成开（只会更严，不等后端）", () => {
  const off = run({ kind: "external", on: false });
  const s = reduceSafeLens(off, { kind: "toggle" });
  expect(s).toMatchObject({ shown: true, lens: true });
});

it("关闭：开关当即显示为关，查询视角等后端确认后才放开（#183）", () => {
  const clicked = run({ kind: "toggle" });
  expect(clicked).toMatchObject({ shown: false, lens: true });
  expect(reduceSafeLens(clicked, { kind: "settled", on: false })).toMatchObject({ shown: false, lens: false });
});

it("确认之前到达的同值事件不提前放开视角，也不改动开关", () => {
  const clicked = run({ kind: "toggle" });
  expect(reduceSafeLens(clicked, { kind: "external", on: false })).toMatchObject({ shown: false, lens: true });
});

it("快速开关：较早那次的确认不覆盖之后的点击，最后一次确认决定结果", () => {
  const s1 = run({ kind: "external", on: true }, { kind: "toggle" }, { kind: "toggle" });
  expect(s1).toMatchObject({ shown: true, lens: true });
  // 关闭那次先确认：之后已点了开启，视角不放开。
  const s2 = reduceSafeLens(s1, { kind: "settled", on: false });
  expect(s2).toMatchObject({ shown: true, lens: true });
  const s3 = reduceSafeLens(s2, { kind: "settled", on: true });
  expect(s3).toMatchObject({ shown: true, lens: true, pending: 0 });
});

it("开→关→开→关：只在最后一次确认时放开", () => {
  let s = run({ kind: "toggle" }, { kind: "toggle" }, { kind: "toggle" });
  expect(s).toMatchObject({ shown: false, lens: true });
  s = reduceSafeLens(s, { kind: "settled", on: false });
  s = reduceSafeLens(s, { kind: "settled", on: true });
  expect(s).toMatchObject({ shown: false, lens: true });
  s = reduceSafeLens(s, { kind: "settled", on: false });
  expect(s).toMatchObject({ shown: false, lens: false, pending: 0 });
});

it("切换失败：开关当即回到开，视角一直是开，之后以重新读到的设置为准", () => {
  const clicked = run({ kind: "toggle" });
  const failed = reduceSafeLens(clicked, { kind: "failed" });
  expect(failed).toMatchObject({ shown: true, lens: true, pending: 0 });
  expect(reduceSafeLens(failed, { kind: "external", on: true })).toMatchObject({ shown: true, lens: true });
});

it("返回乱序：后点的开启先返回、先点的关闭后返回，不采纳关闭，要求重新读取设置", () => {
  let s = run({ kind: "toggle" }, { kind: "toggle" });
  s = reduceSafeLens(s, { kind: "settled", on: true });
  expect(needsRecheck(s, true)).toBe(false);
  s = reduceSafeLens(s, { kind: "settled", on: false });
  expect(s).toMatchObject({ shown: true, lens: true, pending: 0 });
  expect(needsRecheck(s, false)).toBe(true);
});

it("返回乱序的另一面：最后一次是关闭但开启后返回，视角保持开，重新读到关后才放开", () => {
  let s = run({ kind: "external", on: false }, { kind: "toggle" }, { kind: "toggle" });
  s = reduceSafeLens(s, { kind: "settled", on: false });
  s = reduceSafeLens(s, { kind: "settled", on: true });
  expect(s).toMatchObject({ shown: false, lens: true, pending: 0 });
  expect(needsRecheck(s, true)).toBe(true);
  expect(reduceSafeLens(s, { kind: "external", on: false })).toMatchObject({ shown: false, lens: false });
});

it("没有未完成的切换时，外部变化（恢复设置、别处切换）直接采纳", () => {
  const s = run({ kind: "external", on: false });
  expect(s).toMatchObject({ shown: false, lens: false });
  expect(reduceSafeLens(s, { kind: "external", on: true })).toMatchObject({ shown: true, lens: true });
});

it("切换进行中外部报告开启：立即收紧视角（开启永远可以先生效），关闭的报告不放开", () => {
  const off = run({ kind: "external", on: false }, { kind: "toggle" }, { kind: "settled", on: true }, { kind: "toggle" });
  expect(off).toMatchObject({ shown: false, lens: true, pending: 1 });
  const loose = { ...off, lens: false };
  expect(reduceSafeLens(loose, { kind: "external", on: true })).toMatchObject({ lens: true, pending: 1 });
  expect(reduceSafeLens(off, { kind: "external", on: false })).toEqual(off);
});
