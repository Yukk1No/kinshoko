// 图片墙的鼠标滚轮插值与惯性（#102 故事18，#109）。
//
// 每格先算目标位置，再用临界阻尼弹簧追随：每格把目标推远一格，同时给速度加上 ω·格距，
// 所以静止起步时误差按 e^(−t/τ) 收敛（第一帧就动、不越过目标），连续快滚时速度叠加。
// 精确式触控板、笔（产生的不是 wheel 事件）、按住指针（拖滚动条）与“减少动画”都走浏览器原生滚动。

/** 弹簧的时间常数（毫秒）：一格后 120 ms 走完约 63%，约 360 ms 走完 95%。 */
export const SPRING_TAU_MS = 120;

/** 位置与目标为像素，速度为像素／毫秒。 */
export type Spring = { position: number; velocity: number; target: number };

/** 临界阻尼弹簧走 dt 毫秒的精确解（与步长无关）。 */
export function springStep(s: Spring, dt: number, tau = SPRING_TAU_MS): Spring {
  const w = 1 / tau;
  const e0 = s.position - s.target;
  const c = s.velocity + w * e0;
  const decay = Math.exp(-w * dt);
  return { target: s.target, position: s.target + (e0 + c * dt) * decay, velocity: (s.velocity - w * c * dt) * decay };
}

/** 新的一格：目标加 delta，速度加 ω·delta（叠加在正在进行的速度上）。 */
export function addNotch(s: Spring, delta: number, tau = SPRING_TAU_MS): Spring {
  return { position: s.position, target: s.target + delta, velocity: s.velocity + delta / tau };
}

type WheelLike = { deltaMode: number; deltaX: number; deltaY: number; wheelDeltaY?: number };

/**
 * 精确式触控板（或高分辨率滚轮）报的是连续的小增量：带横向分量、非整数，或 Windows 的旧式
 * wheelDeltaY 不是一格（120）的整数倍。按行、按页报的是鼠标滚轮。
 */
export function isPreciseWheel(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0) return true;
  if (typeof e.wheelDeltaY === "number" && e.wheelDeltaY !== 0) return e.wheelDeltaY % 120 !== 0;
  return !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 50;
}

/** 一串触控板事件之间的最长间隔：在这之内后来的整格事件也按触控板走原生，不来回切换。 */
const PRECISE_STICKY_MS = 400;
const LINE_PX = 40;

export type SmoothWheelOptions = {
  /** 最大 scrollTop（按布局算，不读 scrollHeight）。 */
  limit: () => number;
  reducedMotion?: () => boolean;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
};

/** 在滚动容器上接管鼠标滚轮。返回 stop()（停在当前位置）与 dispose()。 */
export function createSmoothWheel(el: HTMLElement, o: SmoothWheelOptions) {
  const now = o.now ?? (() => performance.now());
  const raf = o.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = o.caf ?? ((id) => cancelAnimationFrame(id));
  const reduced = o.reducedMotion ?? (() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  let spring: Spring | null = null;
  /** 上一帧写入的位置；读回不一致说明别处滚动了。 */
  let written = 0;
  let last = 0;
  let frame = 0;
  /** 起步后的第一帧：rAF 的时间戳可能早于输入时刻，按一帧算，保证输入后的第一帧就有位移。 */
  let fresh = false;
  let pressed = false;
  let preciseUntil = -Infinity;

  const stop = () => {
    if (frame) caf(frame);
    frame = 0;
    spring = null;
  };
  const clamp = (s: Spring): Spring => {
    const target = Math.max(0, Math.min(s.target, o.limit()));
    if (target === s.target) return s;
    // 目标被滚动范围截住：改成从当前位置单调收敛到边界，不冲过头再弹回。
    return { position: s.position, target, velocity: -(s.position - target) / SPRING_TAU_MS };
  };
  const step = (t: number) => {
    frame = 0;
    if (!spring) return;
    if (Math.abs(el.scrollTop - written) > 1.5) { spring = null; return; }
    spring = springStep(spring, fresh ? Math.max(t - last, 1000 / 60) : Math.max(1, t - last));
    fresh = false;
    last = t;
    const done = Math.abs(spring.position - spring.target) < 0.5 && Math.abs(spring.velocity) < 0.01;
    el.scrollTop = done ? spring.target : spring.position;
    written = done ? spring.target : spring.position;
    if (done) spring = null;
    else frame = raf(step);
  };

  const wheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const t = now();
    const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
    if (isPreciseWheel({ deltaMode: e.deltaMode, deltaX: e.deltaX, deltaY: e.deltaY, wheelDeltaY: legacy })) {
      preciseUntil = t + PRECISE_STICKY_MS;
      stop();
      return;
    }
    if (t < preciseUntil || pressed || reduced() || e.deltaY === 0) {
      if (t < preciseUntil) preciseUntil = t + PRECISE_STICKY_MS;
      stop();
      return;
    }
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientHeight * 0.875 : e.deltaY;
    // 静止或被别处滚动过：从当前位置起步。
    if (!spring || Math.abs(el.scrollTop - written) > 1.5) {
      spring = { position: el.scrollTop, velocity: 0, target: el.scrollTop };
      written = el.scrollTop;
      last = t;
      fresh = true;
    }
    spring = clamp(addNotch(spring, delta));
    if (!frame) frame = raf(step);
  };
  const press = () => { pressed = true; stop(); };
  const release = () => { pressed = false; };

  el.addEventListener("wheel", wheel, { passive: false });
  el.addEventListener("pointerdown", press);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  return {
    stop,
    dispose() {
      stop();
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    },
  };
}
