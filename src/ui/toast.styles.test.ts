import { describe, expect, it } from "vitest";
import css from "./toast.css?raw";
import dialogsCss from "./dialogsCss";
import { cssRule } from "./cssRule";

const rule = (selector: string) => cssRule(css, selector);

// 设计系统 v3（Toast）：右下角的磨砂卡片，与 Dock 同一种材质；图标放在凹槽里，语气只落在出错的图标颜色上，文字始终是 ink / ink-2。
// 几条提示收起叠在最新一条后面，悬停或聚焦时展开。
describe("轻提示是磨砂卡片（设计系统 v3）", () => {
  const toast = rule(".k-toast");

  it("确认类提示的关闭按钮平时隐去，悬停或聚焦时出现；出错的一直在", () => {
    expect(rule('.k-toast:not([data-tone="error"]) .k-toast-close').opacity).toBe("0");
    expect(rule('.k-toast:not([data-tone="error"]):is(:hover, :focus-within) .k-toast-close').opacity).toBe("1");
  });

  it("隐去的关闭按钮仍占位，悬停不挤窄文字、不让提示换行变高（#388）", () => {
    expect(rule(".k-toast-close").width).toBe("var(--h-sm)");
    for (const state of [
      '.k-toast:not([data-tone="error"]) .k-toast-close',
      '.k-toast:not([data-tone="error"]):is(:hover, :focus-within) .k-toast-close',
    ]) {
      expect(rule(state).width).toBeUndefined();
      expect(rule(state)["margin-left"]).toBeUndefined();
    }
  });

  it("和导入任务卡同一处停靠，按图片墙量出的位置；不再按 body:has 写死让位（#388、#609）", () => {
    expect(rule(".k-toasts").right).toBe("var(--k-notice-right, 18px)");
    expect(rule(".k-toasts").bottom).toBe("var(--k-notice-bottom, 18px)");
    expect(cssRule(dialogsCss, ".k-task-cards").right).toBe("var(--k-notice-right, 18px)");
    expect(cssRule(dialogsCss, ".k-task-cards").bottom).toBe(
      "calc(var(--k-notice-bottom, 18px) + var(--k-toast-stack, 0px))",
    );
    expect(css + dialogsCss).not.toContain("body:has(.selbar-float)");
    expect(css + dialogsCss).not.toContain("body:has(.viewer-dock)");
  });

  it("导入任务卡和轻提示同一套外观：磨砂底、圆角、阴影、图标凹槽与标题字号（#388）", () => {
    const task = cssRule(dialogsCss, ".k-task");
    for (const key of ["background", "backdrop-filter", "border-radius", "box-shadow"])
      expect(task[key]).toBe(toast[key]);
    const icon = cssRule(dialogsCss, ".k-task-icon"),
      toastIcon = rule(".k-toast-icon");
    for (const key of ["background", "box-shadow", "border-radius", "color"]) expect(icon[key]).toBe(toastIcon[key]);
    expect(cssRule(dialogsCss, ".k-task-top b")["font-size"]).toBe(rule(".k-toast-title")["font-size"]);
    expect(cssRule(dialogsCss, ".k-task-top b")["font-weight"]).toBe(rule(".k-toast-title")["font-weight"]);
  });

  it("不写死颜色", () => {
    const block = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});
