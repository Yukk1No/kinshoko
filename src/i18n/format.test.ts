import { describe, expect, it } from "vitest";
import { formatBytes, formatMoment, formatPercent, percentOf } from "./format";

describe("字节数", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1536, "1.5 KB"],
    [30 * 1024 * 1024, "30 MB"],
    [992_916_002, "947 MB"],
    [8123.4 * 1024 * 1024, "7.9 GB"],
    [1024 * 1024 - 1, "1 MB"],
  ])("%s → %s", (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});

describe("百分比", () => {
  it("夹在 0–100，总数为 0 时为 0", () => {
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(12, 10)).toBe(100);
    expect(percentOf(999, 1000)).toBe(99);
    expect(formatPercent(0.87)).toBe("87%");
    expect(formatPercent(1.4)).toBe("100%");
  });
});

describe("日期时间", () => {
  const now = new Date(2026, 9, 10, 14, 40).getTime();
  it("今年不带年份，当天可只显示时间", () => {
    expect(formatMoment(new Date(2026, 2, 5, 9, 5).getTime(), { now })).toBe("3月5日 09:05");
    expect(formatMoment(new Date(2025, 2, 5, 9, 5).getTime(), { now })).toBe("2025年3月5日 09:05");
    expect(formatMoment(new Date(2026, 9, 10, 9, 5).getTime(), { now, todayAsTime: true })).toBe("09:05");
  });
  it("按记录时的时区偏移", () => {
    expect(formatMoment(Date.UTC(2026, 9, 5, 0, 0), { now, offsetMinutes: 480 })).toBe("10月5日 08:00");
  });
});
