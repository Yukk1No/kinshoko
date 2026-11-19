import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["../**/*.{css,ts,tsx}", "!./low-emphasis-buttons.styles.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const RETIRED = ["is-ghost", "is-flush"];
const ALLOWED: Record<string, string> = {};

function retiredClasses(text: string): string[] {
  return RETIRED.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text));
}

describe("低强调按钮", () => {
  it("旧类名不再出现在 src/ 的用处或样式定义里", () => {
    const hits = Object.entries(sources).flatMap(([path, text]) =>
      retiredClasses(text)
        .map((name) => `${path}: ${name}`)
        .filter((hit) => !(hit in ALLOWED)),
    );
    expect(hits).toEqual([]);
  });

  it("扫描认得完整类名，跳过空文本和无关类名", () => {
    expect(retiredClasses("")).toEqual([]);
    expect(retiredClasses('className="k-btn is-ghost is-sm"')).toEqual(["is-ghost"]);
    expect(retiredClasses(".k-btn.is-flush:hover { padding: 0; }")).toEqual(["is-flush"]);
    expect(retiredClasses("fx-ghost tray-ghost subs-section is-quiet is-ghostly prefix-is-flush")).toEqual([]);
  });
});
