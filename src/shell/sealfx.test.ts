import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE, SEAL, SealFx } from "./sealfx";

// 原型的封印／释放影子（#27）：时长与状态按 bd8aea44 的 sealfx.ts。
const rect = (x: number, y: number, w: number, h: number) => new DOMRect(x, y, w, h);
const BOOK = rect(8, 700, 40, 40);

let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => { host.remove(); vi.useRealTimers(); });

const ghosts = () => [...host.querySelectorAll<HTMLElement>(".fx-ghost")];
const blurOf = (g: HTMLElement) => Number(/blur\(([\d.]+)px\)/.exec(g.querySelector("img")!.style.filter)?.[1] ?? 0);

describe("封印影子", () => {
  it("开启：卡片原地在 SEAL.obscure 内模糊到无法辨认，再飞进书里消失", () => {
    const fx = new SealFx(host);
    fx.seal([{ id: "a", src: "a.png", rect: rect(300, 100, 200, 160) }], BOOK);
    // 调用当下就有影子，起点就在卡片原来的位置。
    expect(ghosts()).toHaveLength(1);
    expect(ghosts()[0].style.transform).toContain("translate(300px, 100px)");

    vi.advanceTimersByTime(SEAL.obscure);
    expect(blurOf(ghosts()[0])).toBeGreaterThan(13.5);
    expect(Number(ghosts()[0].querySelector<HTMLElement>(".fx-wash")!.style.opacity)).toBeGreaterThan(0.9);

    vi.advanceTimersByTime(SEAL.flyAt + SEAL.fly);
    expect(ghosts()).toHaveLength(0);
    expect(fx.active).toBe(false);
  });

  it("关闭：影子从书里出来，一路去掉模糊，落到卡片位置后报告落地", () => {
    const fx = new SealFx(host);
    const landed: string[] = [];
    fx.release([{ id: "a", src: "a.png", w: 200, h: 160, target: () => rect(300, 100, 200, 160) }], BOOK, (id) => landed.push(id));
    expect(fx.releasing).toBe(true);
    vi.advanceTimersByTime(16);
    expect(blurOf(ghosts()[0])).toBe(14);

    vi.advanceTimersByTime(RELEASE.flyAt + RELEASE.fly - 36);
    expect(landed).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(landed).toEqual(["a"]);
    expect(ghosts()).toHaveLength(0);
  });

  it("释放途中又开启：还在飞的影子原地掉头飞回书里，不重新生成（原型 Q111）", () => {
    const fx = new SealFx(host);
    const landed: string[] = [];
    fx.release([{ id: "a", src: "a.png", w: 200, h: 160, target: () => rect(300, 100, 200, 160) }], BOOK, (id) => landed.push(id));
    vi.advanceTimersByTime(RELEASE.flyAt + 300);
    const ghost = ghosts()[0];
    fx.seal([{ id: "a", src: "a.png", rect: rect(300, 100, 200, 160) }], BOOK);
    expect(ghosts()).toEqual([ghost]);
    expect(fx.releasing).toBe(false);
    vi.advanceTimersByTime(SEAL.fly + 200);
    expect(ghosts()).toHaveLength(0);
    expect(landed).toEqual([]);
  });

  it("clear 让所有影子立刻走到终点（减少动态效果中途打开时用）", () => {
    const fx = new SealFx(host);
    const landed: string[] = [];
    fx.release([{ id: "a", src: "a.png", w: 200, h: 160, target: () => rect(300, 100, 200, 160) }], BOOK, (id) => landed.push(id));
    fx.clear();
    expect(ghosts()).toHaveLength(0);
    expect(landed).toEqual(["a"]);
  });
});
