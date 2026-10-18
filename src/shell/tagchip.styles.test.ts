import { describe, expect, it } from "vitest";
import css from "./main-window.css?raw";

// 详情面板标签悬停抽搐（#159）：悬停时操作按钮从宽度 0 展开，把标签撑宽，行尾的标签被挤到下一行、离开鼠标又缩回，
// 来回循环。jsdom 不做布局，这里锁住“按钮不占排版宽度、悬停与聚焦只改不影响排版的属性”这两条声明。
const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
const topLevel = plain.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
const ruleBodies = (source: string, selector: string) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => sel.split(",").some((part) => part.trim() === selector))
  .map(([, , body]) => body);
const declarations = (source: string, selector: string) => new Map(ruleBodies(source, selector)
  .flatMap((body) => body.split(";"))
  .filter((decl) => decl.includes(":"))
  .map((decl) => {
    const [name, ...rest] = decl.split(":");
    return [name.trim(), rest.join(":").trim()] as const;
  }));

// #160 起操作按钮和出处一起移进悬停浮层（portal，见 TagPanel.display.test.tsx），标签里只剩名称和图标。
// 这里锁住：悬停、聚焦、浮层打开时只改不影响排版的属性；档位与虚线框不动尺寸；刻度条不占排版。
const LAYOUT = /^(width|height|min-width|max-width|min-height|max-height|padding.*|margin.*|border(-\w+)?-width|border(-(top|right|bottom|left))?|font-size|font-weight|font-family|letter-spacing|gap|column-gap|display|position|flex.*|line-height)$/;
const rulesMatching = (test: (selector: string) => boolean) => [...topLevel.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => sel.split(",").some((part) => test(part.trim())))
  .map(([, sel, body]) => ({ sel: sel.trim(), names: body.split(";").filter((d) => d.includes(":")).map((d) => d.split(":")[0].trim()) }));

describe("详情面板的标签（#159、#160）", () => {
  it("悬停、聚焦或浮层打开时只改不影响排版的属性：标签尺寸不变", () => {
    const states = rulesMatching((sel) => /\.k-tag-chip(\[[^\]]*\])*:(hover|focus|focus-visible|focus-within)\b|\.k-tag-chip\[data-popup-open\]/.test(sel));
    expect(states.length).toBeGreaterThan(0);
    for (const { sel, names } of states) expect(names.filter((name) => LAYOUT.test(name)), sel).toEqual([]);
  });

  it("可信度档位与低档虚线框只改颜色、底色和外框线，不改尺寸", () => {
    const bands = rulesMatching((sel) => sel.includes("[data-band") && sel.includes(".k-tag-chip"));
    expect(bands.map(({ sel }) => sel).join("\n")).toMatch(/data-band="high"/);
    expect(bands.map(({ sel }) => sel).join("\n")).toMatch(/data-low-outline/);
    for (const { sel, names } of bands) expect(names.filter((name) => LAYOUT.test(name)), sel).toEqual([]);
  });

  it("可信度刻度条绝对定位在标签底边，不占排版", () => {
    const meter = declarations(topLevel, ".k-tags .k-tag-meter");
    expect(meter.get("position")).toBe("absolute");
    expect(ruleBodies(topLevel, ".k-tags .k-tag-chip").some((body) => /position:\s*relative/.test(body))).toBe(true);
  });

  it("标签里不再有叠加的操作按钮（#159 的叠加层随 #160 移进浮层）", () => {
    expect(plain).not.toMatch(/\.k-tag-acts/);
  });
});
