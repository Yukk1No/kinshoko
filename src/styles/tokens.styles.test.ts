import { describe, expect, it } from "vitest";

// 颜色只在令牌文件里写值（design/ui-system/README.md「令牌来源」）；其他样式表只写 var(--token)。
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
