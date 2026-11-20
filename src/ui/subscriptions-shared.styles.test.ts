import { describe, expect, it } from "vitest";
import { cssRule } from "./cssRule";

const sheets = import.meta.glob<string>("../**/*.css", { eager: true, query: "?raw", import: "default" });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  eager: true,
  query: "?raw",
  import: "default",
});
const subs = sheets["../subscriptions/subscriptions.css"];
const spinner = sheets["./spinner.css"] ?? "";
function targets(css: string, name: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => new RegExp(`\\.${name}(?![\\w-])`).test(selector))
    .map(([, selector]) => selector.trim().replace(/\s+/g, " "));
}

describe("订阅页共用部件", () => {
  it("旧标记和转圈类不再出现在生产代码", () => {
    const hits = Object.entries({ ...sheets, ...sources }).flatMap(([path, source]) =>
      ["subs-unofficial", "subs-spin"]
        .filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(source))
        .map((name) => `${path}: ${name}`),
    );
    expect(hits).toEqual([]);
  });

  it("转圈只有一个样式来源，继承颜色和图标尺寸，强调色可选", () => {
    expect(cssRule(spinner, ".k-spinner")).toEqual({ animation: "k-spin 0.9s linear infinite" });
    expect(cssRule(spinner, ".k-spinner.is-accent")).toEqual({ color: "var(--accent)" });
    expect(spinner).toContain("transform: rotate(360deg)");
    expect(spinner).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.k-spinner\s*\{\s*animation-duration:\s*2\.4s/,
    );
    const elsewhere = Object.entries(sheets)
      .filter(([path]) => path !== "./spinner.css" && path !== "../styles/tokens.css")
      .flatMap(([path, css]) => targets(css, "k-spinner").map((selector) => `${path}: ${selector}`));
    expect(elsewhere).toEqual([]);
    expect(
      Object.values(sheets)
        .join("\n")
        .match(/@keyframes k-spin\b/g),
    ).toHaveLength(1);
    expect(sources["../main.tsx"]).toContain('import "./ui/spinner.css"');
    expect(sources["../subscriptions/ArtistDialog.tsx"]).toContain('className="k-spinner" size={14}');
    expect(sources["../subscriptions/FollowingDialog.tsx"]).toContain('className="k-spinner" size={14}');
    expect(sources["../subscriptions/SubscriptionsAccount.tsx"]).toContain('className="k-spinner" size={16}');
    expect(sources["../subscriptions/SubscriptionsPage.tsx"]).toContain('className="k-spinner is-accent" size={14}');
    expect(sources["../subscriptions/SubscriptionsEmpty.tsx"]).toContain(
      '<LoaderCircle className="k-spinner is-accent" />',
    );
    expect(cssRule(sheets["./fields.css"], ".k-input > .lucide").color).toBe("var(--ink-3)");
  });

  it("全局减弱动效规则不截断共用转圈", () => {
    const tokens = sheets["../styles/tokens.css"];
    for (const suffix of ["", "::before", "::after"]) expect(tokens).toContain(`*:where(:not(.k-spinner))${suffix}`);
  });

  it("订阅样式不再覆盖分段项或报错文字", () => {
    expect(targets(subs, "k-seg-item")).toEqual([]);
    expect(targets(subs, "k-error-text")).toEqual([]);
    expect(cssRule(sheets["./ui.css"], ".k-seg").padding).toBe("4px");
    expect(cssRule(sheets["./ui.css"], ".k-seg-item").height).toBe("var(--h-sm)");
    expect(sources["../subscriptions/FollowingDialog.tsx"]).toContain('className="k-error-text is-field" role="alert"');
  });

  it("非官方用共用警告胶囊及默认警告图标", () => {
    expect(sources["../subscriptions/UnofficialMark.tsx"]).toContain('<StatusPill tone="warn">');
    expect(sources["./SettingsList.tsx"]).toContain('tone === "warn" && <WarnIcon />');
    expect(cssRule(sheets["./ui-dock.css"], ".k-pill")).toMatchObject({ height: "22px", "font-weight": "600" });
  });

  it("加载和空名单保留正文字号与原间距，颜色来自共用说明", () => {
    expect(cssRule(sheets["./ui.css"], ".k-description:where(.is-body)")).toEqual({
      "font-size": "13px",
      "line-height": "inherit",
    });
    expect(cssRule(subs, ".subs-follow-note")).toEqual({
      display: "flex",
      "align-items": "center",
      gap: "6px",
      padding: "12px",
    });
    expect(
      sources["../subscriptions/FollowingDialog.tsx"].match(/className="k-description is-body subs-follow-note"/g),
    ).toHaveLength(2);
  });

  it("扫描能找到分组、上下文和媒体规则，不误认较长类名", () => {
    expect(targets("", "k-seg-item")).toEqual([]);
    expect(targets(".k-seg-item-icon { color: red }", "k-seg-item")).toEqual([]);
    expect(
      targets("@media (hover: hover) { .other, .context .k-seg-item:hover { height: 26px } }", "k-seg-item"),
    ).toEqual([".other, .context .k-seg-item:hover"]);
  });
});
