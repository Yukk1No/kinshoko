import { describe, expect, it } from "vitest";
import { appCss } from "../test/appCss";
import { cssRule } from "../ui/cssRule";
import stacks from "../shell/main-window-stacks.css?raw";

// 图片墙滚动的开销由这几条声明决定，实测见 PR 说明：窗口最大化、一屏二十多摞时，
// 少了任何一条，滚动都会从每帧 6 ms 退回到十几、二十毫秒。
describe("图片墙滚动时不整面重画", () => {
  it("滚动容器不用 scrollbar-gutter 留滚动条的位置：有它就没有单独的合成层", () => {
    expect(appCss).not.toMatch(/\.wall\s*\{[^}]*scrollbar-gutter/);
    expect(cssRule(appCss, ".wall")["overflow-y"]).toBe("scroll");
  });

  it("一摞下面的纸各自一个合成层，旋转交给合成器", () => {
    expect(cssRule(stacks, ".card.is-stack > .stack-sheet")["will-change"]).toBe("transform");
  });

  it("缩略图到达后占位图用 visibility 隐去，不起 opacity 过渡", () => {
    const placeholder = cssRule(appCss, ".card img[data-loaded] + .card-placeholder");
    expect(placeholder.visibility).toBe("hidden");
    expect(placeholder.transition).toBe("visibility 0s linear 160ms");
    expect(placeholder.opacity).toBeUndefined();
  });
});
