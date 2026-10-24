// #27：安全模式切换时图片墙上的封印／释放动画（原型 sealfx）。动画只是表现：遮蔽照旧在切换的那一帧开始，
// 减少动态效果时没有影子，直接到结束状态。
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { BrowsePage } from "../bindings/BrowsePage";
import { RELEASE, SEAL } from "../shell/sealfx";
import { Wall } from "./Wall";
import { answer, base, card, frames, fx, ghosts, installSealFx, node, PAGE, settle, wallWith } from "./Wall.seal-fx.fixtures";

installSealFx();

describe("封印", () => {
  it("开启的那次提交里卡片就遮蔽，同时生成影子；影子飞进书里后消失", async () => {
    const view = await wallWith(false);
    expect(node("a").dataset.veiled).toBe("false");

    view.rerender(<Wall {...base} reloadKey={0} safeMode />);
    expect(node("a").dataset.veiled).toBe("true");
    expect(ghosts()).toBe(1); // 只有成人图有影子

    await frames(SEAL.flyAt + SEAL.fly + 20);
    expect(ghosts()).toBe(0);
  });

  it("资料库送回卡片后，留下的卡片按原型的节奏补位：影子起飞后 280 ms 开始，620 ms", async () => {
    const view = await wallWith(false);
    const glides: { id: string; timing: KeyframeAnimationOptions }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, _k: Keyframe[], timing: KeyframeAnimationOptions) {
      glides.push({ id: this.dataset.id!, timing });
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={0} safeMode />);
      await frames(100); // 资料库 100 ms 后确认
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      // 资料库按安全模式送回：成人图不在了，留下的 g 补到它的位置。
      await answer({ cards: [card("g")], total: 1, nextCursor: null });
      const g = glides.find((x) => x.id === "g")!;
      expect(g.timing).toMatchObject({ duration: 620, delay: SEAL.flyAt + 20 - 100, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "backwards" });
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("资料库确认得晚也按原型的节奏补位：影子起飞后 280 ms 就开始，资料库回来不打断", async () => {
    const view = await wallWith(false);
    const glides: { id: string; timing: KeyframeAnimationOptions; cancelled: boolean }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, _k: Keyframe[], timing: KeyframeAnimationOptions) {
      const glide = { id: this.dataset.id!, timing, cancelled: false };
      glides.push(glide);
      return { cancel() { glide.cancelled = true; }, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      await frames(SEAL.flyAt + 20 + 16);
      // 资料库还没回来：飞走的图不再占位，g 补到它的位置。
      expect(node("a")).toBeNull();
      const g = glides.filter((x) => x.id === "g");
      expect(g).toHaveLength(1);
      expect(g[0].timing).toMatchObject({ duration: 620, easing: "cubic-bezier(0.65, 0, 0.35, 1)" });
      expect(Number(g[0].timing.delay)).toBeLessThanOrEqual(16);
      // 补位途中资料库送回同样的卡片：不取消、不重来。
      await answer({ cards: [card("g")], total: 1, nextCursor: null });
      expect(glides.filter((x) => x.id === "g")).toHaveLength(1);
      expect(g[0].cancelled).toBe(false);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("补位时挪动的卡片都滑过去，包括点下去时还在视口下方、补位后才进视口的", async () => {
    const many: BrowsePage = { cards: [card("a", true), ...Array.from({ length: 60 }, (_, i) => card(`g${i}`))], total: 61, nextCursor: null };
    const view = render(<Wall {...base} reloadKey={0} safeMode={false} />);
    await answer(many);
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const place = () => new Map([...document.querySelectorAll<HTMLElement>(".card")].map((n) => [n.dataset.id!, { left: parseFloat(n.style.left), top: parseFloat(n.style.top) }]));
    const before = place();
    const glided = new Set<string>();
    HTMLElement.prototype.animate = function (this: HTMLElement) {
      glided.add(this.dataset.id!);
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      await frames(SEAL.flyAt + 20 + 16);
      const after = place();
      const moved = [...after].filter(([id, p]) => {
        const old = before.get(id);
        return old && (old.left !== p.left || old.top !== p.top);
      }).map(([id]) => id);
      // 有在视口（800）以下起步的卡片也挪了，确认这条测试覆盖到了它们。
      expect(moved.some((id) => before.get(id)!.top > 800)).toBe(true);
      expect(moved.filter((id) => !glided.has(id))).toEqual([]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });

  it("减少动态效果时没有影子，封印的图直接离开，不等资料库确认", async () => {
    fx.reduce = true;
    const view = await wallWith(false);
    view.rerender(<Wall {...base} reloadKey={0} safeMode />);
    expect(node("a")).toBeNull();
    expect(node("g")).not.toBeNull();
    expect(ghosts()).toBe(0);
  });

  it("墙上没有成人图时开启：之后无关的重新浏览按平常的 200 ms 重排，不沿用切换时的位置与节奏", async () => {
    const plain: BrowsePage = { cards: [card("g"), card("h")], total: 2, nextCursor: null };
    const view = await wallWith(false, plain);
    const glides: { id: string; timing: KeyframeAnimationOptions }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, _k: Keyframe[], timing: KeyframeAnimationOptions) {
      glides.push({ id: this.dataset.id!, timing });
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode />);
      await frames(SEAL.flyAt + 20 + 16);
      await answer(plain); // 资料库送回同样的卡片
      await frames(100);
      // 之后一次无关的重新浏览在最前面多了一张图，g 与 h 让位。
      view.rerender(<Wall {...base} reloadKey={2} safeMode />);
      await answer({ cards: [card("n"), ...plain.cards], total: 3, nextCursor: null });
      const g = glides.find((x) => x.id === "g")!;
      expect(g.timing).toMatchObject({ duration: 200 });
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    }
  });
});

describe("每次提交只排一次版（#176 性能）", () => {
  it("没有在等飞回的图时，墙上的卡片变了也不去量封印书", async () => {
    const view = await wallWith(false);
    fx.bookReads = 0;
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer({ cards: [card("n"), ...PAGE.cards], total: 3, nextCursor: null });
    expect(node("n")).not.toBeNull();
    expect(fx.bookReads).toBe(0);
  });

  it("重排时先读完滚动位置与卡片矩形，再起滑动动画：起动画之后不再读滚动位置", async () => {
    const view = await wallWith(false);
    const order: string[] = [];
    const scroller = document.querySelector<HTMLElement>(".wall")!;
    const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get() { order.push("read"); return top.get!.call(this); }, set(v) { top.set!.call(this, v); } });
    HTMLElement.prototype.animate = function () {
      order.push("animate");
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    try {
      view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
      await answer({ cards: [card("n"), ...PAGE.cards], total: 3, nextCursor: null });
      expect(order).toContain("animate");
      expect(order.slice(order.indexOf("animate"))).not.toContain("read");
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      delete (scroller as Partial<HTMLElement>).scrollTop;
    }
  });
});

describe("释放", () => {
  it("封印的图还没让出位置就关闭：影子立刻掉头飞回原位，不等资料库", async () => {
    const view = await wallWith(false);
    view.rerender(<Wall {...base} reloadKey={0} safeMode />);
    await frames(100); // 还没到影子起飞后让位的那一刻
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    // 卡片还在原位，先藏着等影子落地；影子只有这一个，掉头飞回。
    expect(node("a").classList.contains("is-arriving")).toBe(true);
    expect(ghosts()).toBe(1);

    await frames(RELEASE.fly + 20);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(0);
  });

  it("关闭后送回的成人图先藏着，影子从书里飞到位置、落地后才显示", async () => {
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    // 资料库确认后重新浏览（App 递增 reloadKey）。
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(node("a").classList.contains("is-arriving")).toBe(true);
    expect(node("g").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(1);

    await frames(RELEASE.flyAt + RELEASE.fly + 20);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(0);
  });

  it("影子落地的那一帧卡片就显示：不留影子已去、卡片还藏着的一帧（不闪）", async () => {
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    await frames(RELEASE.flyAt + RELEASE.fly - 100);
    expect(ghosts()).toBe(1);
    // 逐帧推进，不经 act：React 的普通更新不会在这里提交，看到的就是这一帧画出来的样子。
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const was = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (let i = 0; i < 20 && ghosts() > 0; i++) {
        vi.advanceTimersByTime(16);
        if (ghosts() === 0) expect(node("a").classList.contains("is-arriving")).toBe(false);
      }
      expect(ghosts()).toBe(0);
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = was;
    }
    await settle();
  });

  it("减少动态效果时回来的图直接显示，没有影子", async () => {
    fx.reduce = true;
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(node("a").classList.contains("is-arriving")).toBe(false);
    expect(ghosts()).toBe(0);
  });

  it("飞行中打开系统的减少动态效果：影子立刻落地，卡片显示", async () => {
    const view = await wallWith(true);
    view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
    view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
    await answer();
    expect(ghosts()).toBe(1);
    fx.reduce = true;
    act(() => fx.mediaListeners.forEach((f) => f()));
    expect(ghosts()).toBe(0);
    expect(node("a").classList.contains("is-arriving")).toBe(false);
  });

  it("让位的卡片右下角的图库标记跟着卡片一起滑，不先跳到新位置（#176）", async () => {
    const sourced = (id: string, adult = false) => ({ ...card(id, adult), libraryId: "L1", imageId: id,
      // 标记只在两个及以上图库时出现（#221）。
      sources: [{ libraryId: "L1", libraryName: "角色参考", imageId: id, unavailable: false },
        { libraryId: "L2", libraryName: "场景参考", imageId: id, unavailable: false }] });
    const both: BrowsePage = { cards: [sourced("a", true), sourced("g")], total: 2, nextCursor: null };
    const view = await wallWith(true, { cards: [sourced("g")], total: 1, nextCursor: null });
    const glides: { el: HTMLElement; keyframes: Keyframe[]; timing: KeyframeAnimationOptions }[] = [];
    HTMLElement.prototype.animate = function (this: HTMLElement, keyframes: Keyframe[], timing: KeyframeAnimationOptions) {
      glides.push({ el: this, keyframes, timing });
      return { cancel() {}, finish() {}, onfinish: null } as unknown as Animation;
    } as HTMLElement["animate"];
    HTMLElement.prototype.getAnimations = () => []; // 书的光晕（sealfx.burst）先取消旧动画
    try {
      view.rerender(<Wall {...base} reloadKey={0} safeMode={false} />);
      view.rerender(<Wall {...base} reloadKey={1} safeMode={false} />);
      await answer(both);
      const glide = glides.find((x) => x.el === node("g"))!;
      const badge = glides.find((x) => x.el.matches('.card-sources[data-card="g"]'));
      expect(badge).toBeDefined();
      expect(badge!.timing).toEqual(glide.timing);
      // 卡片同大小只平移：标记从卡片旧位置的右下角滑回，保留自身的 translate(-100%, -100%)。
      const [, dx, dy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(String(glide.keyframes[0].transform))!;
      expect(badge!.keyframes).toEqual([
        { transform: `translate(${dx}px, ${dy}px) translate(-100%, -100%)` },
        { transform: "translate(-100%, -100%)" },
      ]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
    }
  });
});
