import { describe, expect, it } from "vitest";
import css from "./main-window.css?raw";

// 别名输入框被压扁（#181）：别名编辑器是纵向 flex，通用 .k-input 带 flex: 1（基准 0%），在纵向里盖掉了 height: 32px，
// 编辑器又是内容高度、没有空间可分，输入框只剩约 15px。jsdom 不做布局，这里锁住“编辑器里的输入框不参与纵向伸缩”。
const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
const declarations = (selector: string) => new Map([...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, sel]) => sel.split(",").some((part) => part.trim() === selector))
  .flatMap(([, , body]) => body.split(";"))
  .filter((decl) => decl.includes(":"))
  .map((decl) => {
    const [name, ...rest] = decl.split(":");
    return [name.trim(), rest.join(":").trim()] as const;
  }));

describe("标签别名编辑器的输入框", () => {
  it("不随纵向 flex 伸缩，保持 .k-input 声明的高度", () => {
    expect(declarations(".k-tag-alias .k-input").get("flex")).toBe("none");
  });
});
