import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";
import ui from "./ui.css?raw";
import dialogs from "./dialogs.css?raw";
import shell from "../shell/main-window.css?raw";

// jsdom 不排版：这里锁住让文字按字形居中的声明。110% 缩放下实测见 PR 说明。
describe("控件文字垂直居中", () => {
  const label = cssRule(ui, ".k-label");
  const supported = ui.match(/@supports \(text-box: trim-both cap alphabetic\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const trimmed = cssRule(supported, ".k-label");

  it("行框裁到大写字高与基线，不靠被取整的半行距居中", () => {
    expect(trimmed["text-box"]).toBe("trim-both cap alphabetic");
  });

  it("不支持 text-box 的 WebView2 不单独下移文字", () => {
    expect(trimmed["padding-top"]).toBe("0.04em");
    expect(label["padding-top"]).toBeUndefined();
    expect(label["text-box"]).toBeUndefined();
  });

  it("Dock 读数不裁切，原像素星标露在文字右边", () => {
    expect(cssRule(ui, ".k-dock-readout > .k-label")["overflow-x"]).toBe("visible");
  });

  it("只在行内方向裁切，裁短的行框不切掉字形上下", () => {
    expect(label["overflow-x"]).toBe("clip");
    expect(label.overflow).toBeUndefined();
    expect(label["overflow-y"]).toBeUndefined();
  });

  it("套了 .k-label 的侧栏与分组名不再用 overflow: hidden 截断", () => {
    for (const [css, selector] of [[shell, ".k-row .sidebar-label"], [shell, ".lib-head-name .sidebar-label"], [dialogs, ".k-group-label"]] as const) {
      expect(cssRule(css, selector).overflow).toBeUndefined();
    }
  });
});
