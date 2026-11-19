import { describe, expect, it } from "vitest";
import ui from "./uiCss";
import tokens from "../styles/tokens.css?raw";
import { cssRule } from "./cssRule";

/** 层级写成 `var(--z-*)`，数值从令牌文件里取。 */
function layer(value: string): number {
  const name = /^var\((--z-[\w-]+)\)$/.exec(value)?.[1];
  const hit = name && new RegExp(`${name}:\\s*(\\d+);`).exec(tokens);
  return hit ? Number(hit[1]) : Number(value);
}

describe("浮层", () => {
  it("菜单、候选、小确认与悬停提示都压在对话框之上（对话框里也看得见、点得到）", () => {
    const field = layer(cssRule(ui, ".k-positioner")["z-index"]);
    expect(field).toBeGreaterThan(layer(cssRule(ui, ".k-dialog")["z-index"]));
    expect(field).toBeGreaterThan(layer(cssRule(ui, ".k-backdrop")["z-index"]));
  });
});
