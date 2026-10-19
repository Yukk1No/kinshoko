import { expect, it } from "vitest";
import { INITIAL_SAFE_LENS, safeLens, type SafeLens } from "./safeLens";

const run = (...actions: Parameters<typeof safeLens>[1][]): SafeLens => actions.reduce(safeLens, INITIAL_SAFE_LENS);

it("读到设置之前按开启处理：显示与查询都是开", () => {
  expect(INITIAL_SAFE_LENS).toMatchObject({ shown: true, lens: true });
});

it("开启：开关与查询视角当即都变成开（只会更严，不等后端）", () => {
  const off = run({ kind: "external", on: false });
  const s = safeLens(off, { kind: "toggle" });
  expect(s).toMatchObject({ shown: true, lens: true });
});

it("关闭：开关当即显示为关，查询视角等后端确认后才放开（#183）", () => {
  const clicked = run({ kind: "toggle" });
  expect(clicked).toMatchObject({ shown: false, lens: true });
  expect(safeLens(clicked, { kind: "settled", on: false })).toMatchObject({ shown: false, lens: false });
});

it("确认之前到达的同值事件不提前放开视角，也不改动开关", () => {
  const clicked = run({ kind: "toggle" });
  expect(safeLens(clicked, { kind: "external", on: false })).toMatchObject({ shown: false, lens: true });
});

it("快速开关：较早那次的确认不覆盖之后的点击，最后一次确认决定结果", () => {
  const s1 = run({ kind: "external", on: true }, { kind: "toggle" }, { kind: "toggle" });
  expect(s1).toMatchObject({ shown: true, lens: true });
  // 关闭那次先确认：之后已点了开启，视角不放开。
  const s2 = safeLens(s1, { kind: "settled", on: false });
  expect(s2).toMatchObject({ shown: true, lens: true });
  const s3 = safeLens(s2, { kind: "settled", on: true });
  expect(s3).toMatchObject({ shown: true, lens: true, pending: 0 });
});

it("开→关→开→关：只在最后一次确认时放开", () => {
  let s = run({ kind: "toggle" }, { kind: "toggle" }, { kind: "toggle" });
  expect(s).toMatchObject({ shown: false, lens: true });
  s = safeLens(s, { kind: "settled", on: false });
  s = safeLens(s, { kind: "settled", on: true });
  expect(s).toMatchObject({ shown: false, lens: true });
  s = safeLens(s, { kind: "settled", on: false });
  expect(s).toMatchObject({ shown: false, lens: false, pending: 0 });
});

it("切换失败：视角保持开，直到重新读到的设置为准", () => {
  const clicked = run({ kind: "toggle" });
  const failed = safeLens(clicked, { kind: "failed" });
  expect(failed).toMatchObject({ shown: false, lens: true, pending: 0 });
  expect(safeLens(failed, { kind: "external", on: true })).toMatchObject({ shown: true, lens: true });
});

it("没有未完成的切换时，外部变化（恢复设置、别处切换）直接采纳", () => {
  const s = run({ kind: "external", on: false });
  expect(s).toMatchObject({ shown: false, lens: false });
  expect(safeLens(s, { kind: "external", on: true })).toMatchObject({ shown: true, lens: true });
});

it("切换进行中外部报告开启：立即收紧视角（开启永远可以先生效）", () => {
  const clicked = run({ kind: "external", on: false }, { kind: "toggle" }, { kind: "toggle" });
  expect(clicked.lens).toBe(true);
  const off = run({ kind: "external", on: false }, { kind: "toggle" }, { kind: "settled", on: true }, { kind: "toggle" });
  expect(off).toMatchObject({ shown: false, lens: true });
  expect(safeLens(off, { kind: "external", on: true })).toMatchObject({ lens: true });
});
