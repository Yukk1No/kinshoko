import { describe, expect, it } from "vitest";
import css from "./ui.css?raw";
import { cssRule } from "./cssRule";

const rule = (selector: string) => cssRule(css, selector);

// 设计系统 v3（Toast）：右下角的 `ink` 卡片，`bg` 字；图标与操作文字取另一主题的同名色（inverse-*），在实底上保持对比。
describe("轻提示是 ink 卡片（设计系统 v2）", () => {
  const toast = rule(".k-toast");

  it("ink 底、bg 字，圆角与阴影取浮层的", () => {
    expect(toast.background).toBe("var(--ink)");
    expect(toast.color).toBe("var(--bg)");
    expect(toast["border-radius"]).toBe(rule(".k-popup")["border-radius"]);
    expect(toast["box-shadow"]).toBe("var(--shadow-pop)");
  });

  it("标题 13 px，补充一行 12 px", () => {
    expect(rule(".k-toast-title")["font-size"]).toBe("13px");
    expect(rule(".k-toast-desc")["font-size"]).toBe("12px");
  });

  it("图标与操作用 inverse-* 令牌，不写死颜色", () => {
    expect(rule(".k-toast-icon").color).toBe("var(--inverse-ok)");
    expect(rule('.k-toast[data-tone="error"] .k-toast-icon').color).toBe("var(--inverse-danger)");
    expect(rule(".k-toast-action").color).toBe("var(--inverse-accent)");
    const start = css.indexOf("/* ---- Toasts ---- */");
    const block = css.slice(start, css.indexOf("/* ---- Dock", start)).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
