import { describe, expect, it } from "vitest";
import { captureAnchor, cardAt, masonry, resolveAnchor, visible, zoomScrollTop } from "./layout";

// 瀑布流布局沿用 #13 样稿的纯函数（#9 Q27）：尺寸取自资料库记录，不从 DOM 测量。
describe("瀑布流布局", () => {
  const items = [
    { w: 100, h: 100 },
    { w: 100, h: 300 },
    { w: 200, h: 100 },
    { w: 100, h: 900 },
    { w: 100, h: 100 },
    { w: 100, h: 200 },
  ];
  const opts = { width: 640, target: 200, gap: 8, pad: 12, capRatio: null };

  it("按目标列宽分列，每张放进当前最短的一列", () => {
    // 内宽 616，(616+8)/(200+8)=3 列，列宽 (616-16)/3=200。
    const l = masonry(items, opts);
    expect(l.columns).toBe(3);
    expect(l.columnWidth).toBe(200);
    expect(l.boxes.map((b) => [b.x, b.y, b.h])).toEqual([
      [12, 12, 200],
      [220, 12, 600],
      [428, 12, 100],
      [428, 120, 1800],
      [12, 220, 200],
      [12, 428, 400],
    ]);
    expect(l.height).toBe(12 + 100 + 8 + 1800 + 12);
  });

  it("每张保持原比例、不裁切", () => {
    const l = masonry(items, opts);
    l.boxes.forEach((b, i) => expect(b.h / b.w).toBeCloseTo(items[i].h / items[i].w, 6));
  });

  it("特别长的图整体缩小到上限高度，而不是裁切", () => {
    const l = masonry(items, { ...opts, capRatio: 2.6 });
    expect(l.boxes[3].h).toBeCloseTo(200 * 2.6, 6);
    expect(l.boxes[3].w).toBe(200);
  });

  it("二分查找出的可见范围与逐个比较的结果一致", () => {
    const l = masonry(
      Array.from({ length: 200 }, (_, i) => items[i % items.length]),
      opts,
    );
    const brute = l.boxes.flatMap((b, i) => (b.y + b.h >= 500 && b.y < 900 ? [i] : []));
    expect(visible(l, 500, 900)).toEqual(brute);
  });

  it("宽度变化后，锚定的那张图仍在视口中相同的位置", () => {
    const many = Array.from({ length: 300 }, (_, i) => items[i % items.length]);
    const ids = many.map((_, i) => `p${i}`);
    const wide = masonry(many, { ...opts, width: 1200 });
    const anchor = captureAnchor(wide, ids, 3000, 800)!;
    const narrow = masonry(many, { ...opts, width: 700 });
    const top = resolveAnchor(narrow, ids, anchor)!;
    const i = ids.indexOf(anchor.id);
    expect(top - narrow.boxes[i].y).toBeCloseTo(3000 - wide.boxes[i].y, 6);
  });
});

describe("光标下的图", () => {
  const items = [
    { w: 100, h: 100 },
    { w: 100, h: 200 },
    { w: 100, h: 100 },
    { w: 100, h: 100 },
  ];
  const opts = { width: 424, target: 200, gap: 8, pad: 12, capRatio: null };
  // 两列，列宽 196：0 在左列顶（y 12–208），1 在右列顶（y 12–404），2 在左列第二（y 216–412）。
  const l = masonry(items, opts);

  it("落在卡片上时取那一张", () => {
    expect(cardAt(l, 50, 50)).toBe(0);
    expect(cardAt(l, 300, 300)).toBe(1);
    expect(cardAt(l, 50, 250)).toBe(2);
  });

  it("落在缝隙或边距里时取离得最近的一张；墙是空的时为 -1", () => {
    expect(cardAt(l, 5, 214)).toBe(2);
    expect(cardAt(l, 5, 210)).toBe(0);
    expect(cardAt(masonry([], opts), 10, 10)).toBe(-1);
  });
});

// #122：Ctrl+滚轮缩放后列数会变，图片墙只能纵向滚动，所以只锚纵向：光标下那张图仍在视口里，中心仍在光标的高度。
describe("缩放后的滚动位置", () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ w: 100, h: 100 + (i % 7) * 30 }));
  const opts = { width: 2000, target: 240, gap: 8, pad: 12, capRatio: null };
  const viewport = 1000;
  const centerOnScreen = (l: ReturnType<typeof masonry>, i: number, top: number) =>
    l.boxes[i].y + l.boxes[i].h / 2 - top;

  it.each([
    ["放大", 240, 260],
    ["缩小", 260, 240],
    ["放大三格", 240, 320],
    ["缩小三格", 320, 260],
  ])("%s（列数变化）后，那张图的中心仍在光标的高度", (_, from, to) => {
    const before = masonry(items, { ...opts, target: from });
    const after = masonry(items, { ...opts, target: to });
    expect(after.columns).not.toBe(before.columns);
    const scrollTop = 1700;
    const pointerY = 600;
    const i = cardAt(before, 443, scrollTop + pointerY);
    const top = zoomScrollTop(after, i, pointerY, viewport);
    expect(centerOnScreen(after, i, top)).toBeCloseTo(pointerY, 6);
    expect(after.boxes[i].y - top).toBeGreaterThanOrEqual(0);
    expect(after.boxes[i].y + after.boxes[i].h - top).toBeLessThanOrEqual(viewport);
  });

  it("靠近顶部时不滚到负数，那张图仍完整留在视口里", () => {
    const before = masonry(items, opts);
    const after = masonry(items, { ...opts, target: 420 });
    // 未滚动时光标在第一张图的下半部；放大后它的中心仍高于光标，只能停在顶部。
    const i = cardAt(before, 40, 240);
    expect(i).toBe(0);
    const top = zoomScrollTop(after, i, 240, viewport);
    expect(top).toBe(0);
    expect(after.boxes[i].y - top).toBeGreaterThanOrEqual(0);
    expect(after.boxes[i].y + after.boxes[i].h - top).toBeLessThanOrEqual(viewport);
  });

  it("靠近底部时不越过画布底，那张图仍完整留在视口里", () => {
    const before = masonry(items, opts);
    const after = masonry(items, { ...opts, target: 140 });
    const i = items.length - 1;
    const top = zoomScrollTop(after, i, 50, viewport);
    expect(top).toBe(after.height - viewport);
    expect(after.boxes[i].y - top).toBeGreaterThanOrEqual(0);
    expect(after.boxes[i].y + after.boxes[i].h - top).toBeLessThanOrEqual(viewport);
    expect(before.columns).not.toBe(after.columns);
  });

  it("画布比视口矮时停在顶部", () => {
    const short = masonry(items.slice(0, 3), opts);
    expect(zoomScrollTop(short, 2, 700, viewport)).toBe(0);
  });

  it("列数不变时那张图的横向位置也不变", () => {
    const before = masonry(items, { ...opts, target: 240 });
    const after = masonry(items, { ...opts, target: 250 });
    expect(after.columns).toBe(before.columns);
    const i = cardAt(before, 443, 2300);
    expect(after.boxes[i].x).toBe(before.boxes[i].x);
  });
});

// 图集叠成一摞（#418）：一摞仍是一个盒子；打开时墙在这一摞的位置让出跨满整宽的托盘（第 5 版原型的齐行排法）。
describe("一摞与托盘", () => {
  const opts = { width: 640, target: 200, gap: 8, pad: 12, capRatio: null };

  it("一摞的盒子按封面比例算，四周多留出纸边的内缩（内缩按列宽算）", () => {
    // 列宽 200，内缩取列宽的 5%＝10：封面宽 180，方图高 180，长图高 360，盒子各加上下 20。
    const inset = (columnWidth: number) => columnWidth * 0.05;
    const l = masonry(
      [
        { w: 100, h: 100, inset },
        { w: 100, h: 200, inset },
      ],
      opts,
    );
    expect(l.boxes.map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [12, 12, 200, 200],
      [220, 12, 200, 380],
    ]);
  });

  it("托盘从最高的一列底下开始，缩进到墙的边距里；各页按页序排成齐行，墙的其余部分接在托盘下面", () => {
    const items = [
      { w: 100, h: 100 },
      { w: 100, h: 300 },
      // 托盘里的四页：三张方图，一张横图
      { w: 100, h: 100 },
      { w: 100, h: 100 },
      { w: 100, h: 100 },
      { w: 200, h: 100 },
      { w: 100, h: 100 },
    ];
    const l = masonry(items, opts, { at: 2, count: 4, pad: 12 });
    // 前两张：第二列最高，底边 612，加间距 620 处开始托盘；托盘左右缩在墙的边距 12 里，宽 616。
    // 各页的行高以列宽 200 为准：三张方图加间距共 616，超过托盘里的 592，整行缩到 192 刚好排满。
    // 最后一行不撑满：横图按行高 200 排，宽 400。托盘到 832+200+12=1044，高 424。
    expect(l.tray).toEqual({ x: 12, y: 620, w: 616, h: 424 });
    expect(l.boxes.slice(2, 6).map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [24, 632, 192, 192],
      [224, 632, 192, 192],
      [424, 632, 192, 192],
      [24, 832, 400, 200],
    ]);
    // 托盘之后所有列从托盘底边加间距处接着排。
    expect([l.boxes[6].x, l.boxes[6].y]).toEqual([12, 1052]);
    expect(l.height).toBe(1052 + 200 + 12);
  });

  it("比托盘还宽的一页单独成行，缩到托盘里的宽", () => {
    const l = masonry(
      [
        { w: 400, h: 100 },
        { w: 100, h: 100 },
      ],
      opts,
      { at: 0, count: 2, pad: 12 },
    );
    // 横图按行高 200 宽 800，超过 592：单独成行，缩到宽 592、高 148。
    expect(l.boxes[0]).toEqual({ x: 24, y: 24, w: 592, h: 148 });
    // 下一行只有一张方图，是最后一行，按行高排。
    expect(l.boxes[1]).toEqual({ x: 24, y: 24 + 148 + 8, w: 200, h: 200 });
  });

  it("托盘里的页按所在的列计入，挂载范围照常二分查找", () => {
    const items = [
      { w: 100, h: 100 },
      { w: 100, h: 100 },
      { w: 100, h: 100 },
      { w: 100, h: 100 },
    ];
    const l = masonry(items, opts, { at: 0, count: 4, pad: 12 });
    expect(visible(l, 0, 10_000)).toEqual([0, 1, 2, 3]);
    expect(visible(l, l.boxes[3].y, l.boxes[3].y + 10)).toEqual([3]);
  });

  it("没有打开的托盘时没有托盘盒子", () => {
    expect(masonry([{ w: 1, h: 1 }], opts).tray).toBeNull();
  });
});
