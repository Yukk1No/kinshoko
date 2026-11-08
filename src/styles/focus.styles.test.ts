import { describe, expect, it } from "vitest";

// 焦点环只有一种写法（#489）：outline: var(--focus-ring)，偏移只用 var(--focus-offset) / var(--focus-inset)。
// 令牌在 tokens.css；什么时候用负偏移见 design/ui-system/tokens-and-components.md「焦点环」。
const TOKEN_FILE = "./tokens.css";
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

interface Decl { selector: string; prop: string; value: string }

function declarations(css: string): Decl[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.push({ selector, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() });
    }
  }
  return out;
}

const isFocusRule = (selector: string) => /:focus(-visible|-within)?\b|\[data-focus\]/.test(selector);
const OUTLINE_OK = /^(var\(--focus-ring\)|0|none)$/;
const OFFSET_OK = /^var\(--focus-(offset|inset)\)$/;

function offenders(css: string): string[] {
  const bad: string[] = [];
  for (const { selector, prop, value } of declarations(css)) {
    if (!isFocusRule(selector)) continue; // 悬停、选中、拖放等用 outline 画的不是焦点
    if (prop === "outline" && !OUTLINE_OK.test(value)) bad.push(`${selector} { outline: ${value} }`);
    if (prop === "outline-offset" && !OFFSET_OK.test(value)) bad.push(`${selector} { outline-offset: ${value} }`);
    if (prop === "box-shadow" && /var\(--accent(-soft)?\)/.test(value)) bad.push(`${selector} { box-shadow: ${value} }`);
  }
  return bad;
}

describe("焦点环", () => {
  it("令牌文件定义了环与两种偏移", () => {
    const tokens = sheets[TOKEN_FILE];
    for (const t of ["--focus-ring: 2px solid var(--accent)", "--focus-offset: 2px", "--focus-inset: -2px"]) expect(tokens).toContain(t);
  });

  it("除令牌文件外，焦点样式只写 var(--focus-ring) 与偏移令牌，不用 box-shadow 或光晕", () => {
    const found = Object.entries(sheets)
      .filter(([path]) => path !== TOKEN_FILE)
      .flatMap(([path, css]) => offenders(css).map((o) => `${path}: ${o}`));
    expect(found).toEqual([]);
  });

  it("扫描能认出别的写法", () => {
    expect(offenders(".a:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }")).toHaveLength(2);
    expect(offenders(".a:focus-visible { box-shadow: 0 0 0 2px var(--accent); }")).toHaveLength(1);
    expect(offenders(".a:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-inset); }")).toEqual([]);
  });
});
