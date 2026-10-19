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
const mediaBlock = (query: string) => {
  const start = plain.indexOf(`@media ${query}`);
  return start < 0 ? "" : (plain.slice(start).match(/^@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/)?.[1] ?? "");
};

describe("详情面板标签的操作按钮", () => {
  it("叠在标签上，不占排版宽度：悬停前后标签尺寸不变", () => {
    const acts = declarations(topLevel, ".k-tags .k-tag-acts");
    expect(acts.get("position")).toBe("absolute");
    expect(acts.has("max-width")).toBe(false);
    expect(ruleBodies(topLevel, ".k-tags .k-tag-chip").some((body) => /position:\s*relative/.test(body))).toBe(true);
  });

  it("悬停或聚焦时只改透明度与可点性，不改尺寸或边距", () => {
    for (const state of [".k-tags .k-tag-chip:hover .k-tag-acts", ".k-tags .k-tag-chip:focus-within .k-tag-acts"]) {
      const changed = [...declarations(topLevel, state).keys()];
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.every((name) => name === "opacity" || name === "pointer-events")).toBe(true);
    }
  });

  it("隐藏时透明而非 display: none 或 visibility: hidden，Tab 仍能聚焦到按钮", () => {
    const acts = declarations(topLevel, ".k-tags .k-tag-acts");
    expect(acts.get("opacity")).toBe("0");
    expect(acts.get("display")).not.toBe("none");
    expect(acts.has("visibility")).toBe(false);
  });

  it("触屏没有悬停：按钮常显并留在排版里", () => {
    const touch = declarations(mediaBlock("(hover: none)"), ".k-tags .k-tag-acts");
    expect(touch.get("position")).toBe("static");
    expect(touch.get("opacity")).toBe("1");
    expect(touch.get("pointer-events")).toBe("auto");
  });
});
