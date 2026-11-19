import { describe, expect, it } from "vitest";
import uiCss from "./uiCss";
import menuCss from "./menu.css?raw";
import tokensCss from "../styles/tokens.css?raw";
import frameCss from "../shell/mainWindowCss";
import { cssRule } from "./cssRule";
import { flatCss } from "../test/flatCss";

const rule = (selector: string) => cssRule(uiCss, selector);
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

// #601：维护者选定级联菜单外形与 Dock 提示表面；功能样式不能再盖回第二套配方。
describe("浮层与悬停提示只有一套表面", () => {
  const surfaceKeys = [
    "padding",
    "border",
    "border-radius",
    "background",
    "color",
    "font-size",
    "box-shadow",
    "backdrop-filter",
  ];
  const popup = rule(".k-popup");
  const menu = cssRule(menuCss, ".k-popup[data-k-level]");

  it("菜单、下拉、气泡共用 12 圆角、6 内边距、细线与 13 px 字", () => {
    expect(popup).toMatchObject({
      padding: "6px",
      border: "1px solid var(--line)",
      "border-radius": "var(--r)",
      background: "var(--surface)",
      color: "var(--ink)",
      "font-size": "13px",
      "box-shadow": "var(--shadow-pop)",
      "backdrop-filter": "var(--popup-blur)",
    });
    for (const key of surfaceKeys) {
      expect(menu[key], `菜单另写了 ${key}`).toBeUndefined();
      expect({ ...popup, ...menu }[key]).toBe(popup[key]);
    }
    expect(rule(".k-item")["font-size"]).toBe("13px");
    expect(cssRule(menuCss, "[data-k-level] .k-item")["font-size"]).toBeUndefined();
    expect(rule(".k-section-label")["font-size"]).toBe("12px");
    expect(cssRule(menuCss, ".k-menu-title")["font-size"]).toBeUndefined();
  });

  it("浮层模糊用独立令牌，菜单不再给通用颜色和阴影另起别名", () => {
    expect(tokensCss).toContain("--popup-blur: blur(18px) saturate(135%)");
    expect(tokensCss + menuCss).not.toMatch(/--menu-(?:surface|border|ink|hover|quiet|icon|chevron|shadow)\b/);
  });

  it("各处的气泡与下拉只定布局，不另盖一套表面", () => {
    const css = Object.values(sheets).join("\n");
    for (const selector of [
      ".k-rename",
      ".search-more-pop",
      ".k-add-similar",
      ".k-groups-pop",
      ".k-select-popup",
      ".k-listbox",
    ]) {
      const own = cssRule(css, selector);
      for (const key of surfaceKeys) expect(own[key], `${selector} 另写了 ${key}`).toBeUndefined();
    }
  });

  it("标签出处提示的分隔线与按钮跟着纸面主题，不再按反色底配色", () => {
    expect(cssRule(frameCss, ".k-tag-tip .k-tag-tip-acts")["border-top"]).toBe("1px solid var(--line)");
    expect(cssRule(frameCss, ".k-tag-tip .k-tag-tip-btn").background).toBe("var(--hover)");
    expect(cssRule(frameCss, ".k-tag-tip .k-tag-tip-btn:hover").background).toBe("var(--press)");
  });

  it("一般提示与 Dock 提示共用纸面、墨字和 6 / 10 内边距，规则不再留在主窗口", () => {
    const tip = rule(":is(.k-tip, .k-dock-tip)");
    expect(tip).toMatchObject({
      padding: "6px 10px",
      "border-radius": "var(--r-s)",
      background: "var(--surface)",
      color: "var(--ink)",
      "font-size": "12px",
      "line-height": "18px",
      "box-shadow": "var(--shadow-pop)",
    });
    for (const selector of [".k-tip", ".k-dock-tip"]) {
      const own = rule(selector);
      for (const key of surfaceKeys) expect(own[key], `${selector} 另写了 ${key}`).toBeUndefined();
    }
    expect(frameCss).not.toContain(".k-tip");
  });
});

// 共用弹层（Select、Combobox、Popover）进出对称（#455）：从触发点那一侧滑出，再缩回同一侧。
describe("共用弹层按 data-side 定进退场方向", () => {
  const motion = rule(".k-popup:not([data-k-level]):is([data-starting-style], [data-ending-style])");

  it("进场起点与退场终点是同一个状态：淡出、缩小，并朝触发点偏移", () => {
    expect(motion.opacity).toBe("0");
    expect(motion.transform).toBe("translate(var(--k-pop-x), var(--k-pop-y)) scale(0.96)");
    expect(rule(".k-popup")["transform-origin"]).toBe("var(--transform-origin)");
  });

  it("在下方的从上往下，在上方的从下往上，左右同理；不知道在哪一侧时只缩放", () => {
    expect([rule(".k-popup")["--k-pop-x"], rule(".k-popup")["--k-pop-y"]]).toEqual(["0px", "0px"]);
    expect(rule('.k-popup[data-side="bottom"]')["--k-pop-y"]).toBe("-4px");
    expect(rule('.k-popup[data-side="top"]')["--k-pop-y"]).toBe("4px");
    expect(rule('.k-popup:is([data-side="left"], [data-side="inline-start"])')["--k-pop-x"]).toBe("4px");
    expect(rule('.k-popup:is([data-side="right"], [data-side="inline-end"])')["--k-pop-x"]).toBe("-4px");
  });

  it("级联菜单不吃这条：它的进场按 menu.css，退场只淡出", () => {
    expect(cssRule(menuCss, ".k-popup[data-k-level][data-ending-style]").transform).toBeUndefined();
    expect(cssRule(menuCss, '.k-popup[data-k-level][data-side="top"][data-starting-style]').transform).toContain(
      "translateY(6px)",
    );
  });

  it("减弱动效下直接到终态", () => {
    expect(flatCss(tokensCss)).toMatch(/prefers-reduced-motion: reduce\) \{ :root \{[^}]*--t-fast: 0ms/);
  });
});
