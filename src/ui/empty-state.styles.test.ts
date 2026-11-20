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

describe("空状态", () => {
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
    expect(cssRule(sheets["../shell/main-window-panels.css"], ".library-start-content")).toMatchObject({
      overflow: "auto",
      "justify-content": "safe center",
      padding: "24px",
    });
    expect(cssRule(sheets["../shell/main-window-panels.css"], ".library-start-content > .k-empty.is-page")).toEqual({
      flex: "none",
      "align-self": "stretch",
      padding: "0 0 80px",
    });
    expect(cssRule(sheets["./empty-state.css"], ".k-empty-actions:empty")).toEqual({ display: "none" });
  });
});
