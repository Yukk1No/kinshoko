import { describe, expect, it } from "vitest";
import css from "./ui.css?raw";

/** 一条规则的声明（选择器须完全相同）。 */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`缺少规则 ${selector}`);
  return Object.fromEntries(body.split(";").map((d) => d.split(/:(.*)/s).map((s) => s.trim())).filter(([k]) => k));
}
const px = (value: string) => Number(value.replace("px", ""));
const em = (value: string) => Number(value.replace("em", ""));

// jsdom 不排版，按样式表里的数字算出星在 dock 读数里的位置（单位 px）。
describe("原始像素读数上的星（#130）", () => {
  const star = rule(".k-original-star");
  const readout = rule(".k-dock-readout");
  const size = px(readout["font-size"]);

  it("约为字号的 0.8，形状与颜色不变，仍挂在最后一个字的右上角", () => {
    expect(star.width).toBe("0.8em");
    expect(star.height).toBe("0.8em");
    expect(star.position).toBe("absolute");
    expect(star.left).toMatch(/^calc\(100% \+ [\d.]+em\)$/);
    expect(em(star.top)).toBeLessThan(0);
  });

  it("不占排版宽度、不压字、不换行", () => {
    // 绝对定位：读数文字的宽度和换行与没有星时相同。
    expect(rule(".k-original").position).toBe("relative");
    // 从最后一个字的右边缘之后开始画，不盖住文字。
    expect(Number(star.left.match(/\+ ([\d.]+)em/)![1])).toBeGreaterThan(0);
  });

  it("整颗星落在读数框内，不被裁切", () => {
    const height = px(readout.height);
    const width = px(readout["min-width"]) - px(readout["padding-right"]);
    const line = Number(readout["line-height"]) * size;
    const title = Number(readout["line-height"]) * px(rule(".k-dock-readout b")["font-size"]);
    const text = 4 * size; // “原始像素”四个全角字
    // 两行居中：数字一行在上，“原始像素”一行在下。
    const lineTop = (height - title - line) / 2 + title;
    const glyphTop = lineTop + (line - size) / 2;
    const top = glyphTop + em(star.top) * size;
    const bottom = top + em(star.height) * size;
    const right = (width + text) / 2 + Number(star.left.match(/\+ ([\d.]+)em/)![1]) * size + em(star.width) * size;
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(height);
    expect(right).toBeLessThanOrEqual(width);
  });
});
