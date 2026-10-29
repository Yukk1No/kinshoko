import { describe, expect, it } from "vitest";
import { SPRING_TAU_MS, addNotch, createSmoothWheel, isPreciseWheel, springStep, type Spring } from "./smoothWheel";

// #102 故事18（#109）：鼠标滚轮每格先算目标位置，再用临界阻尼弹簧追随（时间常数约 120 ms），连续快滚叠加速度。
describe("临界阻尼弹簧", () => {
  const rest = (at = 0): Spring => ({ position: at, velocity: 0, target: at });
  const run = (s: Spring, ms: number, frame = 1000 / 60) => {
    const path: number[] = [];
    for (let t = 0; t < ms; t += frame) { s = springStep(s, frame); path.push(s.position); }
    return { s, path };
  };

  it("一格后第一帧就动，单调追向目标、不越过，约 120 ms 走完 63%", () => {
    const s = addNotch(rest(), 100);
    expect(s.target).toBe(100);
    const first = springStep(s, 1000 / 60).position;
    expect(first).toBeGreaterThan(5);
    const at120 = springStep(s, SPRING_TAU_MS).position;
    expect(at120).toBeGreaterThan(55);
    expect(at120).toBeLessThan(70);
    const { s: end, path } = run(s, 1000);
    path.forEach((p, i) => { expect(p).toBeLessThanOrEqual(100 + 1e-9); if (i) expect(p).toBeGreaterThanOrEqual(path[i - 1]); });
    expect(end.position).toBeCloseTo(100, 0);
  });

  it("连续快滚：新的一格加在当前目标上，速度叠加，比单格追得更快", () => {
    let s = addNotch(rest(), 100);
    s = springStep(s, 25);
    const single = springStep(s, 16).velocity;
    s = addNotch(s, 100);
    expect(s.target).toBe(200);
    expect(springStep(s, 16).velocity).toBeGreaterThan(single * 1.5);
    const { s: end, path } = run(s, 1200);
    expect(Math.max(...path)).toBeLessThanOrEqual(200 + 1e-9);
    expect(end.position).toBeCloseTo(200, 0);
  });

  it("步长不同也走同一条曲线（逐帧与一次算到同一时刻结果相同）", () => {
    const s = addNotch(rest(), 300);
    let a = s;
    for (let i = 0; i < 10; i++) a = springStep(a, 7);
    const b = springStep(s, 70);
    expect(a.position).toBeCloseTo(b.position, 6);
    expect(a.velocity).toBeCloseTo(b.velocity, 9);
  });
});

describe("哪些滚轮走原生", () => {
  it("鼠标滚轮（一格 120 的倍数、按行）插值", () => {
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(false);
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 0, deltaY: -250, wheelDeltaY: 240 })).toBe(false);
    expect(isPreciseWheel({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(false);
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 0, deltaY: 100 })).toBe(false);
  });

  it("精确式触控板（小增量、非 120 倍数、带横向分量）走原生", () => {
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 0, deltaY: 4, wheelDeltaY: -5 })).toBe(true);
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 2, deltaY: 100, wheelDeltaY: -120 })).toBe(true);
    expect(isPreciseWheel({ deltaMode: 0, deltaX: 0, deltaY: 13.5 })).toBe(true);
  });
});

/** 模拟的滚动容器与动画帧时钟。 */
function harness(o: { reduced?: boolean; limit?: number } = {}) {
  let now = 1000;
  let frames: ((t: number) => void)[] = [];
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, o.limit ?? 10_000)); } });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
  const smooth = createSmoothWheel(el, {
    limit: () => o.limit ?? 10_000,
    reducedMotion: () => o.reduced ?? false,
    now: () => now,
    raf: (cb) => { frames.push(cb); return frames.length; },
    caf: () => { frames = []; },
  });
  const tick = (ms = 1000 / 60) => {
    now += ms;
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(now));
  };
  const wheel = (init: WheelEventInit & { wheelDeltaY?: number }) => {
    const e = new WheelEvent("wheel", { cancelable: true, bubbles: true, deltaMode: 0, ...init });
    if (init.wheelDeltaY !== undefined) Object.defineProperty(e, "wheelDeltaY", { value: init.wheelDeltaY });
    el.dispatchEvent(e);
    return e;
  };
  return { el, smooth, tick, wheel, pending: () => frames.length, get top() { return top; }, set top(v: number) { top = v; } };
}

describe("图片墙的滚轮插值", () => {
  it("鼠标一格：阻止原生滚动，下一帧就有位移，随后平滑到达一格的位置", () => {
    const h = harness();
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(true);
    expect(h.top).toBe(0);
    h.tick();
    expect(h.top).toBeGreaterThan(5);
    expect(h.top).toBeLessThan(100);
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.top).toBe(100);
    expect(h.pending()).toBe(0);
  });

  it("连续快滚叠加：三格落在 300", () => {
    const h = harness();
    h.wheel({ deltaY: 100, wheelDeltaY: -120 });
    h.tick();
    h.wheel({ deltaY: 100, wheelDeltaY: -120 });
    h.tick();
    h.wheel({ deltaY: 100, wheelDeltaY: -120 });
    for (let i = 0; i < 90; i++) h.tick();
    expect(h.top).toBe(300);
  });

  it("目标不超出滚动范围", () => {
    const h = harness({ limit: 150 });
    for (let i = 0; i < 5; i++) h.wheel({ deltaY: 100, wheelDeltaY: -120 });
    for (let i = 0; i < 90; i++) h.tick();
    expect(h.top).toBe(150);
    h.wheel({ deltaY: -100, wheelDeltaY: 120 });
    for (let i = 0; i < 90; i++) h.tick();
    expect(h.top).toBe(50);
  });

  it("精确式触控板走原生：不阻止，也不排动画；同一串事件里后面的整格也走原生", () => {
    const h = harness();
    expect(h.wheel({ deltaY: 4, wheelDeltaY: -5 }).defaultPrevented).toBe(false);
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("“减少动画”时退回原生", () => {
    const h = harness({ reduced: true });
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("按住指针（拖滚动条）时不插值；按下时停下正在进行的插值", () => {
    const h = harness();
    h.wheel({ deltaY: 300, wheelDeltaY: -360 });
    h.tick();
    h.el.dispatchEvent(new Event("pointerdown"));
    const at = h.top;
    h.tick();
    expect(h.top).toBe(at);
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(false);
    window.dispatchEvent(new Event("pointerup"));
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120 }).defaultPrevented).toBe(true);
  });

  it("别处改了滚动位置（键盘、滚动条、锚点恢复）时让出，不把位置拉回去", () => {
    const h = harness();
    h.wheel({ deltaY: 300, wheelDeltaY: -360 });
    h.tick();
    h.top = 2000;
    for (let i = 0; i < 30; i++) h.tick();
    expect(h.top).toBe(2000);
    h.wheel({ deltaY: 100, wheelDeltaY: -120 });
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.top).toBe(2100);
  });

  it("Ctrl、Shift 的滚轮不插值（缩放与横向滚动另有处理）", () => {
    const h = harness();
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(h.wheel({ deltaY: 100, wheelDeltaY: -120, shiftKey: true }).defaultPrevented).toBe(false);
    expect(h.pending()).toBe(0);
  });

  it("stop() 立即停在当前位置", () => {
    const h = harness();
    h.wheel({ deltaY: 300, wheelDeltaY: -360 });
    h.tick();
    const at = h.top;
    h.smooth.stop();
    h.tick();
    expect(h.top).toBe(at);
  });
});
