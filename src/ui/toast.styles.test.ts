import { describe, expect, it } from "vitest";
import css from "./toast.css?raw";
import uiCss from "./ui.css?raw";
import { cssRule } from "./cssRule";

const rule = (selector: string) => cssRule(css, selector);
const uiRule = (selector: string) => cssRule(uiCss, selector);

// 设计系统 v3（Toast）：右下角的磨砂卡片，与 Dock 同一种材质；图标放在凹槽里，语气只落在出错的图标颜色上，文字始终是 ink / ink-2。
// 几条提示收起叠在最新一条后面，悬停或聚焦时展开。
describe("轻提示是磨砂卡片（设计系统 v3）", () => {
  const toast = rule(".k-toast");

  it("半透明 surface 加背景模糊，ink 字，圆角取浮层的，阴影用令牌", () => {
    expect(toast.background).toBe("color-mix(in srgb, var(--surface) 82%, transparent)");
    expect(toast["backdrop-filter"]).toBe("blur(20px) saturate(1.2)");
    expect(toast.color).toBe("var(--ink)");
    expect(toast["border-radius"]).toBe(uiRule(".k-popup")["border-radius"]);
    expect(toast["box-shadow"]).toBe("var(--shadow-toast)");
  });

  it("标题 13 px，补充一行 12 px 的次要字色", () => {
    expect(rule(".k-toast-title")["font-size"]).toBe("13px");
    expect(rule(".k-toast-desc")["font-size"]).toBe("12px");
    expect(rule(".k-toast-desc").color).toBe("var(--ink-2)");
  });

  it("图标在 28 px 凹槽里，只有出错时换成 danger；操作是樱色浅底小按钮", () => {
    const icon = rule(".k-toast-icon");
    expect([icon.width, icon.height]).toEqual(["28px", "28px"]);
    expect(icon.background).toBe("var(--sunken)");
    expect(icon["box-shadow"]).toBe("var(--well-inset)");
    expect(icon.color).toBe("var(--ink-2)");
    expect(rule('.k-toast[data-tone="error"] .k-toast-icon').color).toBe("var(--danger)");
    expect(rule(".k-toast-action").background).toBe("var(--accent-soft)");
    expect(rule(".k-toast-action").color).toBe("var(--accent-strong)");
    expect(rule('.k-toast[data-tone="error"] .k-toast-action').color).toBe("var(--ink)");
    for (const part of [".k-toast-action", ".k-toast-close"]) expect(rule(part).height).toBe("28px");
  });

  it("确认类提示的关闭按钮平时收起，悬停或聚焦时出现；出错的一直在", () => {
    expect(rule('.k-toast:not([data-tone="error"]) .k-toast-close').width).toBe("0");
    expect(rule('.k-toast:not([data-tone="error"]):is(:hover, :focus-within) .k-toast-close').width).toBe("28px");
  });

  it("收起时叠在最新一条后面，展开时按 Base UI 的偏移排开", () => {
    expect(toast.position).toBe("absolute");
    expect(toast.height).toBe("var(--height)");
    expect(rule(".k-toast[data-expanded]").transform).toContain("var(--offset-y)");
    expect(rule(".k-toast-content[data-behind]").opacity).toBe("0");
  });

  it("减少动画时不过渡", () => {
    expect(rule(":root[data-reduced-motion] .k-toast")["transition-duration"]).toBe("0ms");
  });

  it("不写死颜色", () => {
    const block = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
