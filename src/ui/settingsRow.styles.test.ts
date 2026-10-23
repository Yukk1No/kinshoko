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

// jsdom 不排版，按样式表里的数字算设置行的高度（单位 px）。
// 设计系统 v2：每行只有图标、名称、控件，没有描述行；补充说明在悬停提示里，状态是控件左边的小字。
describe("设置行垂直居中（#218，设计系统 v2）", () => {
  const main = rule(settings, ".k-set-row-main");
  const [padTop, padBottom] = padding(main.padding);

  it("一行的最小高度正好放下 32 px 的控件，上下留白相等", () => {
    expect(padTop).toBe(padBottom);
    expect(padTop + 32 + padBottom).toBe(px(main["min-height"]));
    expect(main["align-items"]).toBe("center");
  });

  it("状态小字与控件同一行，不另占一行", () => {
    const meta = rule(ui, ".k-list-meta");
    expect(meta["white-space"]).toBe("nowrap");
    expect(px(meta["font-size"])).toBe(12);
  });

  it("什么都没渲染的行下区域不占位，不把整行内容顶偏（“检查更新”一行偏上）", () => {
    expect(rule(settings, ".k-set-row-below:empty").display).toBe("none");
  });
});
