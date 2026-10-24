import { describe, expect, it } from "vitest";
import fields from "./fields.css?raw";
import ui from "./ui.css?raw";
import { cssRule } from "./cssRule";

describe("输入类控件的浮层", () => {
  it("候选与选择列表压在对话框之上（对话框里也看得见、点得到）", () => {
    const field = Number(cssRule(fields, ".k-positioner.is-field")["z-index"]);
    expect(field).toBeGreaterThan(Number(cssRule(ui, ".k-dialog")["z-index"]));
    expect(field).toBeGreaterThan(Number(cssRule(ui, ".k-backdrop")["z-index"]));
  });
});
