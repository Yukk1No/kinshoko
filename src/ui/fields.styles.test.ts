import { describe, expect, it } from "vitest";
import ui from "./uiCss";
import { cssRule } from "./cssRule";

describe("浮层", () => {
  it("菜单、候选、小确认与悬停提示都压在对话框之上（对话框里也看得见、点得到）", () => {
    const field = Number(cssRule(ui, ".k-positioner")["z-index"]);
    expect(field).toBeGreaterThan(Number(cssRule(ui, ".k-dialog")["z-index"]));
    expect(field).toBeGreaterThan(Number(cssRule(ui, ".k-backdrop")["z-index"]));
  });
});
