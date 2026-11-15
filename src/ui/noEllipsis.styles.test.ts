import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";
import ui from "./uiCss";

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

/** 可以用省略号的选择器：用户自己起的名字、用户给的路径与网址、输入框里的文字（#481）。程序自己的文字放不下就换行、改短或让容器变宽。 */
const ALLOWED = new Set([
  ".k-name",
  ".viewer-title",
  ".create-library-path-text",
  ".k-destination .save-final-position",
  ".insp-links a",
  "input.k-input",
  ".k-input input",
  ".topbar > .search .search-field input",
]);

describe("省略号只留给用户起的名字（#481）", () => {
  it("text-overflow: ellipsis 只出现在白名单里的选择器上", () => {
    const found: string[] = [];
    for (const [path, css] of Object.entries(sheets)) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selectors, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/text-overflow\s*:\s*ellipsis/.test(body)) continue;
        for (const selector of selectors.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
          if (!ALLOWED.has(selector)) found.push(`${path} ${selector}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it(".k-label 本身不截断", () => {
    const rule = cssRule(ui, ".k-label");
    expect(rule["text-overflow"]).toBeUndefined();
    expect(rule["white-space"]).toBeUndefined();
  });
});
