import { expect, it } from "vitest";
import { cssRule } from "./cssRule";

const sheets = import.meta.glob<string>("../**/*.css", { eager: true, query: "?raw", import: "default" });
const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*", "!../test/**"], {
  eager: true,
  query: "?raw",
  import: "default",
});

it("旧订阅名单和行样式退役", () => {
  const retired = /\bsubs-(?:follow-[\w-]+|rank-(?:row[\w-]*|list|pick|name|done))\b/g;
  const hits = Object.entries({ ...sheets, ...sources }).flatMap(([file, source]) =>
    [...source.matchAll(retired)].map(([name]) => `${file}: ${name}`),
  );
  expect(hits).toEqual([]);
  expect(sheets["../subscriptions/subscriptions.css"]).not.toMatch(/\.subs-rank-list\b/);
});

it("行的几何与状态只在共用样式表定义", () => {
  const css = sheets["./selectable-list.css"] ?? "";
  expect(cssRule(css, ".k-choice-row")).toMatchObject({ "min-height": "40px", padding: "0 12px", gap: "10px" });
  expect(cssRule(css, ".k-choice-row.is-on")).toMatchObject({ background: "var(--accent-soft)" });
  expect(cssRule(css, ".k-choice-row:hover")).toMatchObject({ background: "var(--hover)" });
  expect(cssRule(css, ".k-choice-trailing > .k-seg")).toMatchObject({
    display: "grid",
    "grid-auto-columns": "max-content",
  });
  expect(cssRule(css, ".k-choice-leading")).toMatchObject({ width: "24px", height: "24px" });
  expect(cssRule(css, ".k-choice-pick input:focus-visible")).toMatchObject({
    outline: "var(--focus-ring)",
    "outline-offset": "var(--focus-offset)",
  });
  expect(cssRule(css, ".k-choice-list")).toMatchObject({
    "min-height": "var(--k-choice-floor, 0px)",
    "max-height": "min(60vh, 520px)",
  });
  expect(cssRule(css, ".k-choice-name")).toMatchObject({ flex: "1", "min-width": "0" });
  expect(cssRule(sheets["./ui.css"], ".k-name")).toMatchObject({
    "white-space": "nowrap",
    "text-overflow": "ellipsis",
    "overflow-x": "clip",
  });
  expect(cssRule(css, ".k-choice-scroll")).toMatchObject({
    "min-height": "0",
    "max-height": "min(60vh, 520px)",
    "overflow-y": "auto",
    "scrollbar-width": "thin",
  });
  expect(
    Object.entries(sheets).filter(([file, text]) => file !== "./selectable-list.css" && /\.k-choice-row\b/.test(text)),
  ).toEqual([]);
  for (const file of ["FollowingDialog", "RankingDialog"])
    expect(sources[`../subscriptions/${file}.tsx`]).toContain("<SelectableList");
});
