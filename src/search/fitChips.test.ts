// 查找框放不下全部条件标签时（#222）：末尾的放得下几个就显示几个，其余收进前面的“+n”。
import { expect, it } from "vitest";
import { fitChips } from "./fitChips";

const space = { gap: 6, more: 40 };

it("放得下全部时全显示，不要“+n”", () => {
  expect(fitChips([60, 80], 146, space)).toBe(2);
  expect(fitChips([], 0, space)).toBe(0);
});

it("放不下时从末尾数起，给“+n”留出位置", () => {
  // 40 + 6 + 80 = 126 放得下最后一个；再加 6 + 60 就超了。
  expect(fitChips([60, 80], 140, space)).toBe(1);
  expect(fitChips([50, 50, 50, 50], 40 + 6 + 50 + 6 + 50, space)).toBe(2);
});

it("最后一个也放不下时全部收进“+n”", () => {
  expect(fitChips([300], 120, space)).toBe(0);
  expect(fitChips([60, 80], 20, space)).toBe(0);
});
