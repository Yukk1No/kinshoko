import { describe, expect, it } from "vitest";

const sheets = import.meta.glob<string>("../**/*.css", { eager: true, query: "?raw", import: "default" });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  eager: true,
  query: "?raw",
  import: "default",
});
const retired = ["k-chip", "k-group-chip", "search-chip", "k-tag-chip"];
function retiredNames(source: string) {
  const names = retired.filter((name) => new RegExp(`(?<![\\w-])${name}(?:-[\\w-]+)?(?![\\w-])`).test(source));
  const classes = [...source.matchAll(/className=\{?\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
  if (/\.chip(?![\w-])/.test(source) || classes.some((value) => /(?:^|\s)chip(?=\s|\$|$)/.test(value)))
    names.push("chip");
  return names;
}
function rules(css: string) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim().replace(/\s+/g, " "),
    declarations: Object.fromEntries(
      body
        .split(";")
        .filter((d) => d.includes(":"))
        .map((d) => {
          const [name, ...value] = d.split(":");
          return [name.trim(), value.join(":").trim()];
        }),
    ),
  }));
}
const protectedProperty =
  /^(?:font(?:-.+)?|line-height|color|background(?:-.+)?|border(?:-.+)?|padding(?:-.+)?|(?:min-|max-)?(?:width|height)|box-shadow)$/;
const contexts: Record<string, Record<string, string>> = {
  // Reveal actions without changing the condition's resting measurement.
  "../shell/main-window.css: .topbar > .search .k-token.is-condition:is(:hover, :focus-within, :has([data-popup-open]))":
    { "padding-right": "4px" },
  "../shell/main-window.css: .topbar > .search .k-token.is-condition .k-token-action": { width: "0" },
  "../shell/main-window.css: .topbar > .search .k-token.is-condition:is(:hover, :focus-within, :has([data-popup-open])) .k-token-action":
    { width: "20px" },
};
function overrides(path: string, css: string) {
  return rules(css).flatMap(({ selector, declarations }) => {
    if (path === "./token.css") return [];
    if (
      !/\.(?:k-token(?:-[\w-]+)?|is-(?:24|26|28|primary-tag|tag-fill|alias-editor|alias-action|condition-action|member-action|editor-action))(?![\w-])/.test(
        selector,
      )
    )
      return [];
    const allowed = contexts[`${path}: ${selector}`] ?? {};
    return Object.entries(declarations)
      .filter(([name, value]) => protectedProperty.test(name) && allowed[name] !== value)
      .map(([name]) => `${path}: ${selector}: ${name}`);
  });
}
function declarations(selector: string) {
  return rules(sheets["./token.css"] ?? "").find((rule) => rule.selector === selector)?.declarations ?? {};
}
function cascade(selectors: string[]) {
  return rules(Object.values(sheets).join("\n"))
    .filter(({ selector }) => selectors.includes(selector))
    .sort((a, b) => (a.selector.match(/\.[\w-]+/g)?.length ?? 0) - (b.selector.match(/\.[\w-]+/g)?.length ?? 0))
    .reduce((result, rule) => ({ ...result, ...rule.declarations }), {} as Record<string, string>);
}

describe("shared tag tokens", () => {
  it("retires the old names from production sources", () => {
    expect(
      Object.entries({ ...sheets, ...sources }).flatMap(([path, source]) =>
        retiredNames(source).map((name) => `${path}: ${name}`),
      ),
    ).toEqual([]);
  });
  it("distinguishes class names from plural containers, longer names and ordinary variables", () => {
    expect(
      retiredNames(
        'const chip = value; const key = `${id}:chip`; <ul className="k-chips k-tag-chips chipset" /> .chipset {}',
      ),
    ).toEqual([]);
    expect(retiredNames("<li className={`chip pick${state}`} />")).toContain("chip");
    expect(retiredNames('<li className="search-chip" />')).toContain("search-chip");
    expect(retiredNames(".k-chip:hover {}")).toContain("k-chip");
    expect(retiredNames('<li className={"chip pick"} />')).toContain("chip");
    expect(retiredNames(".k-group-chip-name {} .search-chip-or {}")).toEqual(["k-group-chip", "search-chip"]);
    expect(retiredNames("")).toEqual([]);
  });
  it("defines each shared selector exactly once, in token.css", () => {
    const own = rules(sheets["./token.css"] ?? "");
    expect(own.length).toBeGreaterThan(20);
    expect(new Set(own.map(({ selector }) => selector)).size).toBe(own.length);
    for (const selector of [".k-token", ".k-token-action", ".k-token.is-24", ".k-token.is-26", ".k-token.is-28"]) {
      expect(
        Object.entries(sheets).flatMap(([path, css]) =>
          rules(css)
            .filter((r) => r.selector === selector)
            .map(() => path),
        ),
      ).toEqual(["./token.css"]);
    }
    for (const { selector } of own) {
      expect(
        Object.entries(sheets).flatMap(([path, css]) =>
          rules(css)
            .filter((r) => r.selector === selector)
            .map(() => path),
        ),
        selector,
      ).toEqual(["./token.css"]);
    }
  });
  it("owns visual declarations, except the exact search reveal geometry", () => {
    expect(Object.entries(sheets).flatMap(([path, css]) => overrides(path, css))).toEqual([]);
    for (const [key, allowed] of Object.entries(contexts)) {
      const split = key.indexOf(": ");
      expect(
        rules(sheets[key.slice(0, split)]).find((r) => r.selector === key.slice(split + 2))?.declarations,
      ).toMatchObject(allowed);
    }
  });
  it("rejects grouped, contextual, pseudo and media overrides and non-allowlisted values", () => {
    for (const css of [
      ".other, .context .k-token:hover { color: red; }",
      "@media (hover: hover) { .k-token.is-26 { height: 30px; } }",
      ".k-token-action:disabled { background-color: red; }",
      ".is-primary-tag { padding-inline: 0; }",
    ]) {
      expect(overrides("./probe.css", css).length).toBeGreaterThan(0);
    }
    expect(overrides("./probe.css", ".k-tokenizer { color: red; }")).toEqual([]);
    expect(overrides("./probe.css", "")).toEqual([]);
    expect(
      overrides("../shell/main-window.css", ".topbar > .search .k-token.is-condition .k-token-action { width: 21px; }"),
    ).toHaveLength(1);
  });
  it("preserves the issue's 26/28 sizes and all three confidence levels", () => {
    expect(declarations(".k-token.is-26")).toMatchObject({ height: "26px" });
    expect(declarations(".k-token.is-28")).toMatchObject({ height: "28px" });
    expect(declarations(".k-token.is-inspector")).toMatchObject({
      height: "auto",
      "min-height": "26px",
      padding: "4px 8px",
      "font-size": "12px",
    });
    expect(declarations(".k-token.is-inspector .tag-name")).toMatchObject({ "line-height": "18px" });
    expect(declarations(".k-token.is-tag-fill")).toMatchObject({ background: "var(--tag-fill)" });
    expect(declarations('.k-token.is-inspector[data-band="mid"]')).toMatchObject({
      background: "transparent",
      "box-shadow": "inset 0 0 0 1px var(--line-2)",
      color: "var(--ink-2)",
    });
    expect(declarations('.k-token.is-inspector[data-band="low"]')).toMatchObject({
      background: "transparent",
      outline: "1px dashed var(--line-2)",
      "outline-offset": "-1px",
      color: "var(--ink-2)",
    });
    expect(sources["../search/TagGroupPicker.tsx"]).toContain("k-token is-28");
    expect(sources["../search/SearchBox.tsx"]).toContain("is-28");
    expect(sources["../tags/TagChip.tsx"]).toContain("is-inspector");
    expect(sources["../tags/TagChip.tsx"]).toContain("is-primary-tag");
  });
  it("restores the primary 28px design-system size above the ordinary rules in the cascade", () => {
    const legacy = ["k", "tag", "chip"].join("-");
    const primary = cascade([
      `.insp-props .${legacy}`,
      `.k-tags .${legacy}`,
      ".k-token",
      ".k-token.is-26",
      ".k-token.is-inspector",
      ".k-token.is-inspector.is-primary-tag",
    ]);
    expect(primary["min-height"]).toBe("28px");
    expect(primary["padding-inline"]).toBe("10px");
    expect(primary["padding-block"]).toBe("4px");
    expect(primary["font-size"]).toBe("13px");
    expect(
      cascade([
        `.insp-props .${legacy} .tag-name`,
        `.k-tags .${legacy} .tag-name`,
        ".k-token.is-inspector .tag-name",
        ".k-token.is-inspector.is-primary-tag .tag-name",
      ])["line-height"],
    ).toBe("20px");
    expect(declarations(".k-token.is-inspector.is-primary-tag")).toMatchObject({
      "min-height": "28px",
      "padding-inline": "10px",
      "padding-block": "4px",
      "font-size": "13px",
    });
  });
  it("keeps pressed negation actions accent-colored even while hovered", () => {
    const css = sheets["./token.css"] ?? "";
    expect(css.indexOf('.k-token-action.is-condition-action[aria-pressed="true"]')).toBeGreaterThan(
      css.indexOf(".k-token-action.is-condition-action:hover"),
    );
    expect(declarations('.k-token-action.is-condition-action[aria-pressed="true"]')).toEqual({
      color: "var(--accent-strong)",
    });
  });
});
