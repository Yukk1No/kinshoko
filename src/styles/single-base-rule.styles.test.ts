import { describe, expect, it } from "vitest";
import index from "../styles.css?raw";

// 一个类的基础规则（选择器只有这个类本身、不在 @media 之类里面）只写在一份样式表里（#603）。
// 两份里都写，后加载的那份会悄悄盖掉前一份，改样式时改错地方也看不出来。
const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

/** 样式表最外层、选择器只有一个类（如 `.topbar`）的规则的类名，按出现次序。 */
function baseRuleClasses(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        const prelude = text.slice(start, i).trim();
        const single = /^\.([A-Za-z][\w-]*)$/.exec(prelude);
        if (single) found.push(single[1]);
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (ch === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return found;
}

/** 基础规则写在两份以上样式表里的类，和它们所在的样式表。 */
function duplicated(files: Record<string, string>): string[] {
  const where = new Map<string, Set<string>>();
  for (const [path, css] of Object.entries(files)) {
    for (const name of baseRuleClasses(css)) {
      const set = where.get(name) ?? new Set<string>();
      set.add(path);
      where.set(name, set);
    }
  }
  return [...where]
    .filter(([, paths]) => paths.size > 1)
    .map(([name, paths]) => `.${name}: ${[...paths].sort().join(" ")}`)
    .sort();
}

describe("样式表的基础规则", () => {
  it("每个类的基础规则只写在一份样式表里", () => {
    expect(duplicated(sheets)).toEqual([]);
  });

  it("只认最外层、选择器只有一个类的规则", () => {
    const css = `
      @import "./x.css";
      /* .note { color: red; } */
      .topbar { height: 56px; }
      .topbar .k-title { font-weight: 600; }
      .a,
      .b { margin: 0; }
      .topbar:hover { color: red; }
      @media (max-width: 600px) { .rail { width: 0; } }
      .rail { width: 56px; }
    `;
    expect(baseRuleClasses(css)).toEqual(["topbar", "rail"]);
  });

  it("两份样式表写了同一个类的基础规则就报出来", () => {
    expect(
      duplicated({
        "./a.css": ".topbar { height: 52px; } .rail { width: 56px; }",
        "./b.css": ".topbar { height: 56px; } .topbar .x { gap: 0; }",
        "./c.css": ".topbar:hover { color: red; }",
      }),
    ).toEqual([".topbar: ./a.css ./b.css"]);
  });

  it("令牌最先导入", () => {
    expect([...index.matchAll(/@import "([^"]+)"(?:\s+layer\([^)]+\))?;/g)].map(([, path]) => path)[0]).toBe(
      "./styles/tokens.css",
    );
  });
});
