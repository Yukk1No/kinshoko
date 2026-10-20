import { describe, expect, it } from "vitest";
import { selectionBarCompact, selectionBarPlacement } from "./selectionBarPlacement";

// 折叠后的圆形按钮 40 px，离右边 24 px：它的左边在 wallWidth - 64。
const corner = (wallWidth: number) => wallWidth - 24 - 40;

describe("多选悬浮栏的位置（#180）", () => {
  it("宽屏时在图片墙里水平居中，右下角按钮照常显示", () => {
    expect(selectionBarPlacement({ wallWidth: 1200, barWidth: 340, cornerLeft: corner(1200) })).toEqual({ left: 430, hideCorner: false });
  });

  it("居中会挨得太近时整体左移，刚好和圆形按钮隔开 8 px", () => {
    // 宽 480：居中 left 70、右边 410；按钮左边 416，只差 6 px，左移到 416 - 8 - 340 = 68。
    expect(selectionBarPlacement({ wallWidth: 480, barWidth: 340, cornerLeft: corner(480) })).toEqual({ left: 68, hideCorner: false });
  });

  it("左边留不出 16 px 时隐藏圆形按钮，悬浮栏回到居中", () => {
    // 宽 420：要左移到 356 - 8 - 340 = 8，小于 16。
    expect(selectionBarPlacement({ wallWidth: 420, barWidth: 340, cornerLeft: corner(420) })).toEqual({ left: 40, hideCorner: true });
  });

  it("比悬浮栏还窄时贴左边，不留负的位置", () => {
    expect(selectionBarPlacement({ wallWidth: 300, barWidth: 340, cornerLeft: corner(300) })).toEqual({ left: 0, hideCorner: true });
  });
});

describe("窄到放不下完整的悬浮栏时改用紧凑的（#180）", () => {
  it("两边各留 16 px 还放得下就用完整的，放不下才紧凑", () => {
    expect(selectionBarCompact(400, 253)).toBe(false);
    expect(selectionBarCompact(285, 253)).toBe(false);
    expect(selectionBarCompact(284, 253)).toBe(true);
  });
  it("还没量到完整宽度时按完整的算", () => {
    expect(selectionBarCompact(100, 0)).toBe(false);
  });
});
