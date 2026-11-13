import { describe, expect, it } from "vitest";
import uiCss from "./ui.css?raw";
import menuCss from "./menu.css?raw";
import tokensCss from "../styles/tokens.css?raw";
import { cssRule } from "./cssRule";

const rule = (selector: string) => cssRule(uiCss, selector);

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

  it("不再写死只从上往下", () => {
    expect(uiCss).not.toMatch(/translateY\(-4px\)/);
  });

  it("级联菜单不吃这条：它的进场按 menu.css，退场只淡出", () => {
    expect(cssRule(menuCss, ".k-popup[data-k-level][data-ending-style]").transform).toBeUndefined();
    expect(cssRule(menuCss, '.k-popup[data-k-level][data-side="top"][data-starting-style]').transform).toContain("translateY(6px)");
  });

  it("减弱动效下直接到终态", () => {
    expect(tokensCss).toMatch(/prefers-reduced-motion: reduce\) \{ :root \{[^}]*--t-fast: 0ms/);
  });
});
