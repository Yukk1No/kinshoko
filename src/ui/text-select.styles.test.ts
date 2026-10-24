import { describe, expect, it } from "vitest";
import css from "./text-select.css?raw";
import { appCss } from "../test/appCss";

// 主界面默认不能拖选文字（#224）：误拖出的选区没有用处，只有要复制的内容才放开。
// jsdom 不做层叠，这里按样式表锁住声明。
const rules = (selector: string, sheet = css) => [...sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => sel.split(",").some((part) => part.trim() === selector))
  .map(([, , body]) => body);
const declares = (selector: string, property: string, value: string, sheet = css) =>
  rules(selector, sheet).some((body) => body.split(";").some((decl) => {
    const [name, ...rest] = decl.split(":");
    return name.trim() === property && rest.join(":").trim() === value;
  }));

describe("文字选取（#224）", () => {
  it("主窗口 body 默认不能选文字，弹层等一并继承；实验窗口等不受影响", () => {
    expect(declares(':root[data-view="main"] body', "user-select", "none")).toBe(true);
  });

  it.each([
    "input",
    "textarea",
    '[contenteditable]:not([contenteditable="false"])',
    ".insp-file-name",
    ".insp-links",
    ".workspace-source-path",
    ".import-report-path",
    ".import-report-reason",
    ".create-library-path-text",
    '[role="alert"]',
    '.k-toast[data-tone="error"]',
    ".k-list-desc.is-warn",
    ".settings-error",
  ])("%s 仍可选中复制", (selector) => {
    expect(declares(selector, "user-select", "text")).toBe(true);
  });

  it("诊断框仍可选中复制", () => {
    expect(declares(".settings-diagnostics", "user-select", "text", appCss)).toBe(true);
  });

  it("可复制区域里的按钮不跟着被选", () => {
    expect(declares('[role="alert"] button', "user-select", "none")).toBe(true);
    expect(declares('.k-toast[data-tone="error"] button', "user-select", "none")).toBe(true);
  });
});
