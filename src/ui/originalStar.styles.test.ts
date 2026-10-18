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

// jsdom 不排版，按样式表里的数字估算星在 dock 读数里的位置（单位 px）。真实程序（110%）中实测：
// 读数框 96×40，星 9.6×9.6，从最后一个字之后 0.7px 开始，上下各离框边 18px 与 12px。
describe("原始像素读数上的星（#130）", () => {
  const star = rule(".k-original-star");
  const readout = rule(".k-dock-readout");
  const size = px(readout["font-size"]);
  const gap = em(star.left.match(/^calc\(100% \+ ([\d.]+em)\)$/)?.[1] ?? "NaN");

  it("约为字号的 0.8，形状与颜色不变，仍挂在最后一个字的右上角", () => {
    expect(star.width).toBe("0.8em");
    expect(star.height).toBe("0.8em");
    expect(em(star.top)).toBeLessThan(0);
  });

  it("不占排版宽度、不换行，也不压住“原始像素”", () => {
    // 绝对定位挂在 .k-original 上：读数文字的宽度与换行与没有星时相同。
    expect(rule(".k-original").position).toBe("relative");
    expect(star.position).toBe("absolute");
    // 从最后一个字的右边缘之后开始画。
    expect(gap).toBeGreaterThan(0);
  });

  it("整颗星落在读数框内，不被裁切", () => {
    const height = px(readout.height);
    // 最窄时的内容宽：min-width 减去右侧内边距与 1px 分隔线（border-box）。
    const width = px(readout["min-width"]) - px(readout["padding-right"]) - 1;
    const lineHeight = Number(readout["line-height"]);
    const numberLine = lineHeight * px(rule(".k-dock-readout b")["font-size"]);
    const labelLine = lineHeight * size;
    const labelWidth = 4 * size; // “原始像素”四个全角字
    // 两行居中：数字一行在上，“原始像素”一行在下。
    const labelTop = (height - numberLine - labelLine) / 2 + numberLine + (labelLine - size) / 2;
    const top = labelTop + em(star.top) * size;
    const bottom = top + em(star.height) * size;
    const right = (width + labelWidth) / 2 + gap * size + em(star.width) * size;
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(height);
    expect(right).toBeLessThanOrEqual(width);
  });
});
