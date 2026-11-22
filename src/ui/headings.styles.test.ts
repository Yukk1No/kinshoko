import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";

// 16 px 标题与 12 px 分组名各只有一个共用类（design/ui-system/scales.md「共用类」）。
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!./headings.styles.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const RETIRED = [
  "pane-title",
  "subs-title",
  ["subs", "empty", "title"].join("-"),
  "k-set-heading",
  "k-set-title",
  "k-dialog-title",
  "k-menu-label",
  "k-field-label",
  "k-add-similar-head",
  "k-tag-alias-title",
  "subs-group-head",
];
// 字号与字重跟标题或分组名一样、但不是标题或分组名的规则，写明理由。
const ALLOWED: Record<string, string> = {
  ".k-big-tag-name": "对话框正文里放大显示的标签名，是内容不是标题",
  ".k-pill": "胶囊自带底色和圆角，是控件不是分组名",
  ".insp-sec h4, .insp-h": "检查器分区标题沿用 h4 的 24 px 行高，并进来会改检查器的行距，单独处理",
  ".insp-prop > dt": "检查器属性名，行高跟着 28 px 的属性行",
};

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 自己写出标题（16 px、600）或分组名（12 px、600、--ink-2）字形的规则。 */
function typeRoleRules(css: string): string[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => {
      if (!/font-weight:\s*600\s*[;}]?/.test(body)) return false;
      if (/font-size:\s*16px/.test(body)) return true;
      return /font-size:\s*12px/.test(body) && /color:\s*var\(--ink-2\)/.test(body);
    })
    .map(([, selector]) => selector.trim().replace(/\s+/g, " "));
}

describe("标题与分组名", () => {
  it("旧类名不再出现在 src/", () => {
    const hits = Object.entries({ ...sheets, ...sources }).flatMap(([path, text]) =>
      RETIRED.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map((name) => `${path}: ${name}`),
    );
    expect(hits).toEqual([]);
  });

  it("共用类写在 src/ui/ui.css，别处不另写一份字形", () => {
    const hits = Object.entries(sheets).flatMap(([path, css]) =>
      typeRoleRules(css)
        .filter((selector) => !(path === "./ui.css" && (selector === ".k-title" || selector === ".k-section-label")))
        .filter((selector) => !(selector in ALLOWED))
        .map((selector) => `${path}: ${selector}`),
    );
    expect(hits).toEqual([]);
  });

  it("标题 16 / 24 / 600，分组名 12 / 18 / 600 次要墨色", () => {
    const ui = sheets["./ui.css"];
    expect(cssRule(ui, ".k-title")).toMatchObject({
      margin: "0",
      "font-size": "16px",
      "line-height": "24px",
      "font-weight": "600",
    });
    expect(cssRule(ui, ".k-section-label")).toMatchObject({
      margin: "0",
      "font-size": "12px",
      "line-height": "18px",
      "font-weight": "600",
      color: "var(--ink-2)",
    });
  });

  it("扫描认得出另写的标题和分组名，跳过注释与别的字形", () => {
    expect(
      typeRoleRules(
        "/* .x { font-size: 16px; font-weight: 600; } */ .a { font-size: 16px; font-weight: 600; } " +
          ".b { font-size: 12px; font-weight: 600; color: var(--ink-2); } .c { font-size: 12px; font-weight: 600; } " +
          ".d { font-size: 13px; font-weight: 600; color: var(--ink-2); }",
      ),
    ).toEqual([".a", ".b"]);
  });
});
