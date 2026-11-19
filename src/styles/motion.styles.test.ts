import { describe, expect, it } from "vitest";

// 时长只取令牌（design/ui-system/scales.md「动效」）：样式里的 transition、animation 不写数字时长。
const TOKEN_FILE = "./tokens.css";
// 确有理由写死的地方列在这里，并写明理由。
const ALLOWED: Record<string, string> = {
  "./library.css": "封印与释放演出、安全模式遮蔽是品牌不变项，数值不动（design/ui-system/brand-invariants.md）",
};
// 单条例外：“文件: 值”。
const ALLOWED_VALUES: Record<string, string> = {
  "../subscriptions/subscriptions.css: 2.4s": "减弱动效下转圈放慢后的周期：转圈是循环动画，有自己的周期",
};

const sheets = import.meta.glob<string>("../**/*.css", { query: "?raw", import: "default", eager: true });

/** transition、animation 及其分项里写死的非零时长。循环播放的动画（呼吸、转圈）有自己的周期，不算。 */
function hardDurations(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...code.matchAll(/(?<![\w-])(?:transition|animation)(?:-[a-z-]+)?\s*:\s*([^;}]+)/g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((value) => !value.includes("infinite"))
    .filter((value) => [...value.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/g)].some((d) => Number(d[1]) !== 0));
}

describe("动效令牌", () => {
  it("令牌文件之外的过渡与动画不写数字时长", () => {
    const offenders = Object.entries(sheets)
      .filter(([path]) => path !== TOKEN_FILE && !(path in ALLOWED))
      .flatMap(([path, css]) => hardDurations(css).map((value) => `${path}: ${value}`))
      .filter((hit) => !(hit in ALLOWED_VALUES));
    expect(offenders).toEqual([]);
  });

  it("扫描认得出写死的时长，跳过 0、令牌、注释与循环动画", () => {
    expect(
      hardDurations(
        "/* opacity 9ms */ .a { transition: opacity 120ms var(--ease); } .b { transition: opacity var(--t) var(--ease); }" +
          " .c { transition-duration: 0ms; } .d { animation: spin 0.9s linear infinite; } .e { transition-delay: 250ms; }",
      ),
    ).toEqual(["opacity 120ms var(--ease)", "250ms"]);
  });
});
