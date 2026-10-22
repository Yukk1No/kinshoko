import { describe, expect, it } from "vitest";
import css from "./ui.css?raw";

/** 一条规则的声明（选择器须完全相同）。 */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`缺少规则 ${selector}`);
  return Object.fromEntries(body.split(";").map((d) => d.split(/:(.*)/s).map((s) => s.trim())).filter(([k]) => k));
}

describe("通知与右键菜单、改名浮层同一套外观（#214）", () => {
  const toast = rule(".k-toast");
  const popup = rule(".k-popup");

  it("底色、文字色、圆角与阴影（含 1px 描边）都取弹层的", () => {
    for (const key of ["background", "color", "border-radius", "box-shadow"]) expect(toast[key]).toBe(popup[key]);
  });

  it("标题用菜单项的字号，说明文字用次级墨色而非半透明", () => {
    expect(rule(".k-toast-title")["font-size"]).toBe("13px");
    const desc = rule(".k-toast-desc");
    expect(desc.color).toBe("var(--ink-2)");
    expect(desc.opacity).toBeUndefined();
  });

  it("三种语气的图标与操作都用设计令牌，不写死颜色", () => {
    expect(rule(".k-toast-icon").color).toBe("var(--ok)");
    expect(rule('.k-toast[data-tone="info"] .k-toast-icon').color).toBe("var(--ink-2)");
    expect(rule('.k-toast[data-tone="error"] .k-toast-icon').color).toBe("var(--danger)");
    expect(rule(".k-toast-action").color).toBe("var(--accent-strong)");
    const block = css.slice(css.indexOf("/* ---- Toasts ---- */"), css.indexOf("/* ---- Dock")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
