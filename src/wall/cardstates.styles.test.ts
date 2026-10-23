import { describe, expect, it } from "vitest";
import { appCss as css } from "../test/appCss";

// 卡片自身藏着的时候（交给封印影子、或从书里飞回还没落地），它旁边的来源按钮也不能先露出来（#154）。
const lines = css.split(/\r?\n/).map((line) => line.trim());

describe("藏着的卡片连同来源按钮一起藏", () => {
  it("飞回中的卡片：来源按钮等落地后再出现", () => {
    expect(lines.some((line) => line.includes(".card.is-arriving + .card-sources") && line.includes("visibility: hidden"))).toBe(true);
  });

  it("交给封印影子的卡片：来源按钮同样不显示", () => {
    expect(lines.some((line) => line.includes('.card[data-leaving="true"] + .card-sources') && line.includes("visibility: hidden"))).toBe(true);
  });
});

// 藏着的卡片看不见遮蔽的过渡：模糊滤镜的过渡不能交给合成器，留着它会让主线程在封印／释放的每一帧都重绘（#176）。
describe("藏着的卡片不跑遮蔽过渡", () => {
  const rule = (selector: string) => {
    const i = css.indexOf(selector);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };
  it("交给封印影子的卡片与飞回中的卡片：图片的模糊和墨色都不过渡", () => {
    for (const selector of ['.card[data-leaving="true"] img', '.card[data-leaving="true"]::after', ".card.is-arriving img", ".card.is-arriving::after"]) {
      expect(rule(selector), selector).toMatch(/transition:\s*none/);
    }
  });
  it("这条规则写在遮蔽过渡之后，同等优先级时由它生效", () => {
    expect(css.indexOf('.card.is-arriving img')).toBeGreaterThan(css.indexOf('.card img[data-loaded="instant"]'));
  });
});
