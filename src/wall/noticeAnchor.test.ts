import { describe, expect, it } from "vitest";
import { noticeAnchor } from "./noticeAnchor";

describe("通知跟着图片墙停靠（#609）", () => {
  const viewport = { width: 1600, height: 900 };

  it("详情栏收起：右边和右下角那一组对齐，底边在那一组上方隔 12", () => {
    // 图片墙一直铺到窗口右边、底边离窗口底 8；右下角那一组 bottom 20、高 40。
    const anchor = noticeAnchor({
      host: { right: 1592, bottom: 892, width: 1300 },
      viewport,
      inset: 24,
      rowTop: 60,
    });
    expect(anchor).toEqual({ right: 32, bottom: 80, maxWidth: 1252 });
  });

  it("详情栏打开：停在图片墙右边，不盖详情栏", () => {
    const anchor = noticeAnchor({ host: { right: 1260, bottom: 892, width: 968 }, viewport, inset: 24, rowTop: 60 });
    expect(anchor.right).toBe(364);
  });

  it("多选悬浮栏比右下角那一组高时，按悬浮栏让开", () => {
    const corner = noticeAnchor({ host: { right: 1592, bottom: 892, width: 1300 }, viewport, inset: 24, rowTop: 60 });
    const bar = noticeAnchor({ host: { right: 1592, bottom: 892, width: 1300 }, viewport, inset: 24, rowTop: 76 });
    expect(bar.bottom - corner.bottom).toBe(16);
  });

  it("图片墙很窄时，通知的最大宽度不超过图片墙减两边留白", () => {
    expect(
      noticeAnchor({ host: { right: 500, bottom: 892, width: 300 }, viewport, inset: 16, rowTop: 56 }).maxWidth,
    ).toBe(268);
  });
});
