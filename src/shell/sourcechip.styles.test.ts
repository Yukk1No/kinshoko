import { describe, expect, it } from "vitest";
import css from "./main-window.css?raw";

// 图片墙来源标记（#124）：按钮绝对定位在卡片右下角再左移自身宽度，收缩适配的可用宽度只剩卡片右缘到画布右缘，
// 最右一列的“2 处”因此换行、溢出胶囊。jsdom 不做布局，这里锁住不换行、宽度随内容的声明。
const rules = (selector: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => sel.split(",").some((part) => part.trim() === selector))
  .map(([, , body]) => body);
const declares = (selector: string, property: string, value: string) =>
  rules(selector).some((body) => body.split(";").some((decl) => {
    const [name, ...rest] = decl.split(":");
    return name.trim() === property && rest.join(":").trim() === value;
  }));

describe("图片墙来源标记", () => {
  it("图标、数字与“处”始终单行，胶囊宽度随内容，不受画布右缘挤压", () => {
    expect(declares(".wall-canvas > .card-sources", "white-space", "nowrap")).toBe(true);
    expect(declares(".wall-canvas > .card-sources", "width", "max-content")).toBe(true);
  });

  it("图标不被压缩", () => {
    expect(declares(".wall-canvas > .card-sources > svg", "flex", "none")).toBe(true);
  });
});
