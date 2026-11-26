import { describe, expect, it } from "vitest";
import { flatCss } from "../test/flatCss";
import { cssRule } from "../ui/cssRule";
import css from "./pixiv.css?raw";

const HOVER = ".pw-account-item.is-control .k-select:hover:not([data-popup-open])";
const CASCADE_KEEP =
  ".pw-account-item.is-control .k-select:hover:not(:disabled):not([data-disabled]):not([data-popup-open]):not(:focus-visible)";

describe("pixiv 样式的层叠迁移", () => {
  it("账号下拉悬停时保留迁移前由共用 Select 取胜的槽影", () => {
    const compact = flatCss(css);
    expect(cssRule(compact, HOVER)["box-shadow"]).toBe("none");
    expect(cssRule(compact, CASCADE_KEEP)["box-shadow"]).toBe("var(--well-inset-hover)");
    expect(compact.indexOf(CASCADE_KEEP)).toBeGreaterThan(compact.indexOf(HOVER));
  });
});
