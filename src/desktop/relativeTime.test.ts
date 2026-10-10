import { describe, expect, it } from "vitest";
import { ago } from "./relativeTime";

const now = new Date(2026, 9, 10, 14, 40).getTime();
const minutes = (n: number) => now - n * 60_000;

describe("侧栏里的相对时间", () => {
  it.each([
    [minutes(0.5), "刚刚"],
    [minutes(27), "27 分钟前"],
    [minutes(120), "2 小时前"],
    [new Date(2026, 9, 9, 23, 0).getTime(), "昨天"],
    [new Date(2026, 9, 2, 9, 0).getTime(), "10 月 2 日"],
    [new Date(2025, 11, 30, 9, 0).getTime(), "2025 年 12 月 30 日"],
  ])("%s → %s", (at, text) => expect(ago(at, now)).toBe(text));
  it("一小时内按分钟算；更早且跨过零点按日历算昨天", () => {
    expect(ago(new Date(2026, 9, 10, 0, 10).getTime(), new Date(2026, 9, 10, 0, 50).getTime())).toBe("40 分钟前");
    expect(ago(new Date(2026, 9, 9, 23, 50).getTime(), new Date(2026, 9, 10, 0, 50).getTime())).toBe("昨天");
  });
});
