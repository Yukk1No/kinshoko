import { describe, expect, it } from "vitest";

// 颜色只在令牌文件里写值（design/ui-system/tokens-and-components.md「令牌来源」）；其他样式表只写 var(--token)。
const TOKEN_FILE = "./tokens.css";
// 确有理由写死颜色的样式表列在这里，并写明理由。目前没有。
const ALLOWED: Record<string, string> = {};

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

function hexLiterals(css: string): string[] {
  // 注释里的 #102 之类是工单号，不是颜色。
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
}

describe("颜色令牌", () => {
  it("令牌文件定义了 v3 的日夜主色", () => {
    const tokens = sheets[TOKEN_FILE];
    for (const value of ["--bg: #f7f3ea", "--ink: #2b2747", "--accent: #e0768f", "--bg: #1e1c2c", "--seal-acc: #c85672"]) {
      expect(tokens).toContain(value);
    }
  });

  it("令牌文件之外的样式表不写十六进制颜色", () => {
    const offenders = Object.entries(sheets)
      .filter(([path]) => path !== TOKEN_FILE && !(path in ALLOWED))
      .flatMap(([path, css]) => hexLiterals(css).map((hex) => `${path}: ${hex}`));
    expect(offenders).toEqual([]);
  });

  it("扫描能认出写在样式里的颜色，跳过注释", () => {
    expect(hexLiterals("/* #102 */ .a { color: #fff; border: 1px solid #A63A55cc; }")).toEqual(["#fff", "#A63A55cc"]);
  });
});

// 日间取第一段 `:root { … }`，夜间取手动的 `:root[data-theme="dark"]` 段（与跟随系统的那段相同）。
function themeTokens(theme: "day" | "night"): Record<string, string> {
  const tokens = sheets[TOKEN_FILE].replace(/\/\*[\s\S]*?\*\//g, "");
  const start = theme === "day" ? tokens.indexOf(":root {") : tokens.indexOf(':root[data-theme="dark"], .k-dock.is-dark {');
  const block = tokens.slice(start, tokens.indexOf("\n}", start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

type Rgb = [number, number, number];
function rgba(value: string): [Rgb, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as Rgb, 1];
  const fn = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!fn) throw new Error(`不是纯色：${value}`);
  return [[+fn[1], +fn[2], +fn[3]], +fn[4]];
}
/** 前景色落在底色上的对比度；半透明的底先叠在 `under` 上。 */
function contrast(fg: string, bg: string, under?: string): number {
  const [b, alpha] = rgba(bg);
  const ground = alpha < 1 ? b.map((c, i) => c * alpha + rgba(under!)[0][i] * (1 - alpha)) as Rgb : b;
  const lum = (rgb: Rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(rgba(fg)[0]), lum(ground)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("警告、强调、人工三种颜色分开（#482）", () => {
  for (const theme of ["day", "night"] as const) {
    const t = themeTokens(theme);
    it(`${theme === "day" ? "日间" : "夜间"}：警告色不和强调色、人工色、危险色共用一个值`, () => {
      // 夜间强调色和人工色同为金色，靠金星而不是颜色分开；警告色和它们都不同。
      for (const other of ["--accent", "--manual", "--danger"]) expect(t["--warn"], other).not.toBe(t[other]);
      expect(t["--warn-strong"]).not.toBe(t["--manual-strong"]);
    });
    it(`${theme === "day" ? "日间" : "夜间"}：警告文字在各层底色上、胶囊文字在浅底上都到 4.5:1`, () => {
      for (const ground of ["--bg", "--surface", "--surface-2", "--sunken"]) {
        expect(contrast(t["--warn"], t[ground]), ground).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t["--warn-strong"], t["--warn-soft"], t["--surface"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["--manual-strong"], t["--manual-soft"], t["--surface"])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
