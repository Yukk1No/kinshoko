import { describe, expect, it } from "vitest";
import settings from "./settings.css?raw";
import ui from "./ui.css?raw";

/** 一条规则的声明（选择器须完全相同）。 */
function rule(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`缺少规则 ${selector}`);
  return Object.fromEntries(body.split(";").map((d) => d.split(/:(.*)/s).map((s) => s.trim())).filter(([k]) => k));
}
const px = (value: string) => Number(value.replace("px", ""));
/** `padding` 简写的上、下内边距。 */
const padding = (value: string) => { const [top, , bottom = top] = value.split(/\s+/).map(px); return [top, bottom]; };

// jsdom 不排版，按样式表里的数字算设置行的高度（单位 px）。正文行高 20px（styles.css 的 body）。
// 在浏览器里渲染设置页、按 150% 缩放实测：说明沿用 20px 行高时，标题加说明的文字块比图标高出约 1.2px，
// 有说明的行也比没有说明的行高 2px（#218）。
describe("设置行的文字垂直居中（#218）", () => {
  const main = rule(settings, ".k-set-row-main");
  const [padTop, padBottom] = padding(main.padding);
  const titleLine = 20;

  it("说明按 12px 字号配 18px 行高，标题加说明正好填满一行的最小高度", () => {
    const desc = rule(settings, ".k-set-row .k-list-desc");
    expect(px(desc["line-height"])).toBe(18);
    expect(padTop + titleLine + px(desc["line-height"]) + padBottom).toBe(px(main["min-height"]));
  });

  it("只改设置行：共享列表的说明样式不定行高，其他页面的行高不变", () => {
    expect(rule(ui, ".k-list-desc")["line-height"]).toBeUndefined();
  });
});
