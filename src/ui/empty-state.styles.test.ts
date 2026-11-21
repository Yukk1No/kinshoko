import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";

const sources = import.meta.glob<string>(["../**/*.{css,ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });
const retired =
  /(?<![\w-])(?:subs-empty(?:-[\w-]+)?|wall-empty(?:-[\w-]+)?|app-empty-body|capture-history-empty|reference-groups-empty|k-tags-empty|tag-empty|k-groups-empty|groupbar-empty|k-option-empty)(?![\w-])/g;
const oldNames = (text: string) => [...text.matchAll(retired)].map(([name]) => name);
const sharedSelectors = new Set([
  ".k-empty.is-page",
  ".k-empty.is-list",
  ".k-empty-icon",
  ".k-empty-hint",
  ".k-empty-actions",
]);
const comboSelector = ".k-combo-empty > .k-empty.is-list";

function overrides(path: string, css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) => {
    selector = selector.trim().replace(/\s+/g, " ");
    if (!/\.k-empty(?:-(?:icon|hint|actions))?(?![\w-])/.test(selector)) return [];
    const properties = [...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map(([, name]) => name);
    const protectedProperties = properties.filter((name) =>
      /^(?:font(?:-[\w-]+)?|line-height|color|padding(?:-[\w-]+)?|margin(?:-[\w-]+)?|(?:row-|column-)?gap|text-align)$/.test(
        name,
      ),
    );
    if (path === "./empty-state.css" && sharedSelectors.has(selector)) return [];
    if (path === "./fields.css" && selector === comboSelector) {
      return protectedProperties.filter((name) => !/^padding(?:-|$)/.test(name)).map((name) => `${selector}: ${name}`);
    }
    return protectedProperties.map((name) => `${selector}: ${name}`);
  });
}

describe("空状态", () => {
  it("分组或区域选择器不能另改共用空状态的字形、颜色或间距", () => {
    expect(
      Object.entries(sheets).flatMap(([path, css]) => overrides(path, css).map((hit) => `${path}: ${hit}`)),
    ).toEqual([]);
  });

  it("检查覆盖时识别分组、区域、伪类和媒体规则，忽略注释及无关类名", () => {
    expect(overrides("./other.css", ".other, .panel .k-empty-hint:hover { color: red; margin-inline: 2px; }")).toEqual([
      ".other, .panel .k-empty-hint:hover: color",
      ".other, .panel .k-empty-hint:hover: margin-inline",
    ]);
    expect(
      overrides("./other.css", "@media (width < 500px) { .panel .k-empty { font-size: 13px; row-gap: 8px; } }"),
    ).toEqual([".panel .k-empty: font-size", ".panel .k-empty: row-gap"]);
    expect(
      overrides(
        "./other.css",
        "/* .k-empty { color: red; } */ .k-emptyish { color: red; } .panel .k-empty { min-height: 100%; }",
      ),
    ).toEqual([]);
    expect(overrides("./empty-state.css", ".extra, .k-empty-actions { gap: 4px; }")).toEqual([
      ".extra, .k-empty-actions: gap",
    ]);
    expect(
      overrides("./fields.css", `${comboSelector} { padding: 0 10px 0 32px; font: 13px sans-serif; color: red; }`),
    ).toEqual([`${comboSelector}: font`, `${comboSelector}: color`]);
    expect(overrides("./other.css", "")).toEqual([]);
  });
  it("生产代码不再使用旧空状态类", () => {
    expect(Object.entries(sources).flatMap(([path, text]) => oldNames(text).map((name) => `${path}: ${name}`))).toEqual(
      [],
    );
  });

  it("识别完整类名、旧类的子元素，跳过无关名称和空文本", () => {
    expect(oldNames("")).toEqual([]);
    expect(oldNames('className="wall-empty subs-empty-actions k-option-empty"')).toEqual([
      "wall-empty",
      "subs-empty-actions",
      "k-option-empty",
    ]);
    expect(oldNames("not-wall-empty wall-emptyish k-tags-emptyish tag-emptyish")).toEqual([]);
  });

  it("共用定义只在一个样式表，区域规则只调布局", () => {
    for (const selector of [
      ".k-empty.is-page",
      ".k-empty.is-list",
      ".k-empty-icon",
      ".k-empty-hint",
      ".k-empty-actions",
    ]) {
      expect(
        Object.entries(sheets).flatMap(([path, css]) =>
          [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].filter(([, found]) => found.trim() === selector).map(() => path),
        ),
      ).toEqual(["./empty-state.css"]);
    }
    expect(cssRule(sheets["./empty-state.css"], ".k-empty.is-page")).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      "align-items": "center",
      "justify-content": "center",
      gap: "12px",
      padding: "0 24px 80px",
      "text-align": "center",
    });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty-icon")).toMatchObject({
      width: "56px",
      height: "56px",
      "border-radius": "var(--r-l)",
      background: "var(--sunken)",
      color: "var(--ink-3)",
    });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty-icon > svg")).toEqual({ width: "24px", height: "24px" });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty-hint")).toEqual({ margin: "0", color: "var(--ink-2)" });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty.is-list")).toMatchObject({
      margin: "0",
      padding: "0 2px",
      "font-size": "12px",
      "line-height": "18px",
      color: "var(--ink-2)",
      "text-align": "left",
    });
    expect(sources["./EmptyState.tsx"]).toContain('className="k-title"');
    expect(sheets["./empty-state.css"]).not.toContain("font-size: 16px");
  });

  it("可搜索下拉保留行高和名称左边距，不改空状态字形", () => {
    expect(cssRule(sheets["./fields.css"], ".k-combo-empty > .k-empty.is-list")).toEqual({
      display: "flex",
      "align-items": "center",
      "min-height": "32px",
      padding: "0 10px 0 32px",
      cursor: "default",
    });
    expect(cssRule(sheets["../shell/welcome.css"], ".library-start-content")).toMatchObject({
      overflow: "auto",
      "justify-content": "safe center",
      padding: "24px",
    });
    expect(cssRule(sheets["../shell/welcome.css"], ".library-start-content > .k-empty.is-page")).toEqual({
      flex: "none",
      "align-self": "stretch",
    });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty-actions:empty")).toEqual({ display: "none" });
  });
});
