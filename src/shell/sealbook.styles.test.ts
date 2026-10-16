import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";

// 封印书是品牌不变项：样式须与原型 bd8aea44:prototype/reference-browser/src/styles.css 一字不差。
// 旧版图标留下的 `.seal-book svg { stroke: currentColor }` 曾让书和锁都描上一圈墨色。
const PROTOTYPE_RULES = [
  ".seal-book { --bb: var(--rail); --seal-cut: var(--bb); background: var(--bb); }",
  ".seal-book:hover { --bb: color-mix(in srgb, var(--ink) 7%, var(--rail)); background: var(--bb); }",
  ".seal-book:active { --bb: color-mix(in srgb, var(--ink) 12%, var(--rail)); }",
  ".seal-book.is-sealed { --bb: color-mix(in srgb, var(--seal-acc) 14%, var(--rail)); }",
  ".seal-book.is-sealed:hover { --bb: color-mix(in srgb, var(--seal-acc) 20%, var(--rail)); }",
  ".seal-book.is-sealed:active { --bb: color-mix(in srgb, var(--ink) 12%, var(--rail)); }",
  ".seal-book:hover svg { transform: none; }",
  ".seal-book:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }",
];
const PROTOTYPE_COLOURS = [
  ":root { --seal-acc: #C85672; --seal-ink: var(--ink); }",
  "@media (prefers-color-scheme: dark) { :root:not([data-theme=\"light\"]) { --seal-acc: #E3B34F; } }",
  ":root[data-theme=\"dark\"] { --seal-acc: #E3B34F; }",
];

const lines = css.split(/\r?\n/).map((line) => line.trim());

describe("封印书样式", () => {
  it("只有原型的那几条规则作用于封印书", () => {
    expect(lines.filter((line) => line.includes(".seal-book"))).toEqual(PROTOTYPE_RULES);
  });

  it("锁色按原型分主题：日间樱色、夜间金色", () => {
    for (const rule of PROTOTYPE_COLOURS) expect(lines).toContain(rule);
    expect(lines.filter((line) => /--seal-(acc|ink)\s*:/.test(line))).toEqual(PROTOTYPE_COLOURS);
  });
});
