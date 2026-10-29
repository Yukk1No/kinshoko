import { describe, expect, it } from "vitest";
import css from "./ui.css?raw";
import { cssRule } from "./cssRule";

const rule = (selector: string) => cssRule(css, selector);
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

  it("不占排版宽度、不换行，也不压住读数", () => {
    // 绝对定位挂在 .k-original 上：读数文字的宽度与换行与没有星时相同。
    expect(rule(".k-original").position).toBe("relative");
    expect(star.position).toBe("absolute");
    // 从最后一个字的右边缘之后开始画。
    expect(gap).toBeGreaterThan(0);
  });

  it("整颗星落在读数框内，不被裁切", () => {
    // 设计系统 v2：读数只有一行“宽 × 高”，星挂在最后一个数字的右上角，伸进右侧内边距。
    const height = px(readout.height);
    const [, right] = readout.padding.split(/\s+/).map(px);
    const lineHeight = px(readout["line-height"]);
    const textTop = (height - lineHeight) / 2 + (lineHeight - size) / 2;
    const top = textTop + em(star.top) * size;
    const bottom = top + em(star.height) * size;
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(height);
    expect((gap + em(star.width)) * size).toBeLessThanOrEqual(right);
  });
});
