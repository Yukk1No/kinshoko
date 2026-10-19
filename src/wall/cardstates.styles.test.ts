import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";

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
