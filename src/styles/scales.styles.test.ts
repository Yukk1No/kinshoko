import { describe, expect, it } from "vitest";

// 控件高度、层级、不可用、半透明面板只取令牌（design/ui-system/scales.md）。
const TOKEN_FILE = "./tokens.css";
// 确有理由写死的地方列在这里，并写明理由。
const ALLOWED_BACKDROP: Record<string, string> = {
  "../ui/menu.css": "级联菜单的模糊归浮层一类，由 #601 定（design/ui-system/scales.md「半透明浮动面板」）",
};

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 写成数字、且在 10 以上的 `z-index`。组件内部 1–9 的叠放不算；`calc()` 里按序号叠放的不算。 */
function bigZIndexes(css: string): string[] {
  return [...stripComments(css).matchAll(/z-index:\s*(\d+)\s*[;}]/g)]
    .filter((m) => Number(m[1]) >= 10)
    .map((m) => m[0]);
}

/** 不可用规则（`:disabled`、`[data-disabled]`、`[aria-disabled]`）里写死的、小于 1 的透明度。 */
function hardDisabledOpacity(css: string): string[] {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /:disabled|\[data-disabled|\[aria-disabled/.test(m[1]))
    .flatMap((m) => [...m[2].matchAll(/opacity:\s*(0?\.\d+)\s*;/g)].map((o) => `${m[1].trim()} → ${o[1]}`));
}

/** 不经令牌的 `backdrop-filter`。 */
function hardBackdrops(css: string): string[] {
  return [...stripComments(css).matchAll(/backdrop-filter:\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !/^var\(--[\w-]+\)$/.test(v) && v !== "none");
}

function offenders(scan: (css: string) => string[], allowed: Record<string, string> = {}): string[] {
  return Object.entries(sheets)
    .filter(([path]) => path !== TOKEN_FILE && !(path in allowed))
    .flatMap(([path, css]) => scan(css).map((hit) => `${path}: ${hit}`));
}

describe("档位令牌", () => {
  it("10 以上的层级只用 --z-* 令牌", () => {
    expect(offenders(bigZIndexes)).toEqual([]);
  });

  it("不可用的深浅只用 --disabled-opacity", () => {
    expect(offenders(hardDisabledOpacity)).toEqual([]);
  });

  it("半透明面板的模糊只用令牌", () => {
    expect(offenders(hardBackdrops, ALLOWED_BACKDROP)).toEqual([]);
  });

  it("扫描认得出各类写死的写法，跳过注释与例外", () => {
    expect(
      bigZIndexes("/* z-index: 99; */ .a { z-index: 3; } .b { z-index: 40; } .c { z-index: calc(100 - var(--i)); }"),
    ).toEqual(["z-index: 40;"]);
    expect(
      hardDisabledOpacity(".a:disabled { opacity: 0.4; } .b:hover { opacity: 0.4; } .c:disabled { opacity: 1; }"),
    ).toEqual([".a:disabled → 0.4"]);
    expect(hardBackdrops(".a { backdrop-filter: blur(12px); } .b { backdrop-filter: var(--glass-blur); }")).toEqual([
      "blur(12px)",
    ]);
  });
});
