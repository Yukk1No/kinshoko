// Seal and release effects for the image wall (#27, Q97, Q104, Q105, Q109, Q111).
// Cards that leave or enter the wall are drawn as "ghosts" in a fixed layer above everything and
// fly between their place on the wall and the seal book. Every ghost keeps its current values,
// so a seal during a release (Q111) turns each one around from where it is, without a jump.

import { clamp, ease } from './sealbook';

type Ease = (t: number) => number;
type Pose = { x: number; y: number; s: number; rot: number };
type Flight = { t0: number; dur: number; to: () => Pose | null; eXY: Ease; eS: Ease; from?: Pose };
type Tween = { from: number; to: number; t0: number; dur: number; e: Ease };
type Ghost = {
  id: string; el: HTMLDivElement; img: HTMLImageElement; wash: HTMLDivElement; w: number; h: number;
  pose: Pose; blur: number; wash0: number; op: number;
  flight: Flight | null; queue: Flight[]; tweens: Partial<Record<'blur' | 'wash' | 'op', Tween>>;
  mode: 'seal' | 'release'; onLand?: () => void; endAt: number;
};

export type FxSource = { id: string; src: string; rect: DOMRect };
export type FxArrival = { id: string; src: string; w: number; h: number; target: () => DOMRect | null };
export type FxReport = { kind: 'seal' | 'release'; ms: number; frames: number; worstFrame: number; ghosts: number };

/** Timings in ms at normal speed; `slow` stretches them for frame-by-frame checks. */
export const SEAL = { obscure: 240, flyAt: 260, stagger: 30, fly: 520, fade: 140 };
export const RELEASE = { burstAt: 120, flyAt: 150, stagger: 55, fly: 760, clearAt: 260, clear: 420 };
export const MAX_GHOSTS = 40;

export class SealFx {
  slow = 1;
  onReport?: (r: FxReport) => void;
  private ghosts = new Map<string, Ghost>();
  private raf = 0;
  private run: { kind: 'seal' | 'release'; t0: number; frames: number; last: number; worst: number; ghosts: number } | null = null;
  private burstEl: HTMLDivElement;

  constructor(private host: HTMLElement) {
    this.burstEl = document.createElement('div');
    this.burstEl.className = 'fx-burst';
    host.appendChild(this.burstEl);
  }

  get releasing() { return [...this.ghosts.values()].some((g) => g.mode === 'release'); }
  get active() { return this.ghosts.size > 0; }

  /** Safe mode on: the given cards blur past recognition within SEAL.obscure ms, then fly into the book. */
  seal(sources: FxSource[], book: DOMRect) {
    const now = performance.now(), T = (ms: number) => ms * this.slow;
    this.begin('seal', now);
    const target = (g: Ghost, k: number) => () => {
      const sc = clamp(28 / Math.max(g.w, g.h), 0.02, 1);
      return { x: book.left + book.width / 2 - g.w / 2, y: book.top + book.height / 2 - g.h / 2, s: sc, rot: (k % 2 ? 1 : -1) * 14 };
    };
    let k = 0;
    // Ghosts already in the air (a release that has not finished) turn around first: Q111.
    for (const g of this.ghosts.values()) {
      g.mode = 'seal'; g.onLand = undefined; g.queue = [];
      this.tween(g, 'blur', 14, now, T(200), ease.outC);
      this.tween(g, 'wash', 0.92, now, T(200), ease.outC);
      this.tween(g, 'op', 1, now, T(60), ease.lin);
      g.flight = null;
      g.queue.push({ t0: now + T(40 + k * 20), dur: T(SEAL.fly - 80), to: target(g, k), eXY: ease.inC, eS: ease.inC });
      g.endAt = now + T(40 + k * 20 + SEAL.fly - 80);
      this.tween(g, 'op', 0, g.endAt - T(SEAL.fade), T(SEAL.fade), ease.lin);
      k++;
    }
    for (const s of sources.slice(0, MAX_GHOSTS)) {
      if (this.ghosts.has(s.id)) continue;
      const g = this.make(s.id, s.src, s.rect.width, s.rect.height, { x: s.rect.left, y: s.rect.top, s: 1, rot: 0 }, 'seal');
      g.blur = 0; g.wash0 = 0; g.op = 1;
      this.tween(g, 'blur', 14, now, T(SEAL.obscure), ease.outC);
      this.tween(g, 'wash', 0.92, now, T(SEAL.obscure - 20), ease.outC);
      const at = SEAL.flyAt + k * SEAL.stagger;
      g.queue.push({ t0: now, dur: T(220), to: () => ({ x: s.rect.left, y: s.rect.top, s: 0.94, rot: 0 }), eXY: ease.outC, eS: ease.outC });
      g.queue.push({ t0: now + T(at), dur: T(SEAL.fly), to: target(g, k), eXY: ease.inC, eS: ease.inC });
      g.endAt = now + T(at + SEAL.fly);
      this.tween(g, 'op', 0, g.endAt - T(SEAL.fade), T(SEAL.fade), ease.lin);
      k++;
    }
    this.loop();
  }

  /** Safe mode off: the book opens and the cards fly out to their places on the wall (Q97, Q104). */
  release(arrivals: FxArrival[], book: DOMRect, onLand: (id: string) => void) {
    const now = performance.now(), T = (ms: number) => ms * this.slow;
    this.begin('release', now);
    this.burst(now + T(RELEASE.burstAt), book);
    const live = (a: FxArrival) => () => { const r = a.target(); return r ? { x: r.left, y: r.top, s: 1, rot: 0 } : null; };
    arrivals.slice(0, MAX_GHOSTS).forEach((a, k) => {
      let g = this.ghosts.get(a.id);
      const at = RELEASE.flyAt + k * RELEASE.stagger;
      if (g) {
        // Still on its way into the book: head back out from where it is.
        g.mode = 'release'; g.queue = []; g.flight = null;
        g.queue.push({ t0: now, dur: T(RELEASE.fly), to: live(a), eXY: ease.outC, eS: ease.back(1.9) });
        this.tween(g, 'op', 1, now, T(80), ease.lin);
        this.tween(g, 'blur', 0, now + T(300), T(RELEASE.clear), ease.outC);
        this.tween(g, 'wash', 0, now + T(RELEASE.clearAt), T(RELEASE.clear), ease.outC);
        g.endAt = now + T(RELEASE.fly);
      } else {
        const sc = clamp(28 / Math.max(a.w, a.h), 0.02, 1);
        g = this.make(a.id, a.src, a.w, a.h, { x: book.left + book.width / 2 - a.w / 2, y: book.top + book.height / 2 - a.h / 2, s: sc, rot: (k % 2 ? -1 : 1) * 24 }, 'release');
        g.blur = 14; g.wash0 = 0.92; g.op = 0;
        this.tween(g, 'op', 1, now + T(at), T(100), ease.lin);
        g.queue.push({ t0: now + T(at), dur: T(RELEASE.fly), to: live(a), eXY: ease.outC, eS: ease.back(1.9) });
        this.tween(g, 'blur', 0, now + T(at + 300), T(RELEASE.clear), ease.outC);
        this.tween(g, 'wash', 0, now + T(at + RELEASE.clearAt), T(RELEASE.clear), ease.outC);
        g.endAt = now + T(at + RELEASE.fly);
      }
      g.onLand = () => onLand(a.id);
    });
    this.loop();
  }

  /** "可打断" (Q105): jump every ghost to the end of its flight. */
  finish() {
    for (const g of [...this.ghosts.values()]) this.end(g);
    this.burstEl.getAnimations().forEach((a) => a.finish());
  }

  /** Reduced motion turned on mid-effect, or the wall was rebuilt: end everything now. */
  clear() { this.finish(); }

  // ------------------------------------------------------------ internals
  private begin(kind: 'seal' | 'release', now: number) {
    this.report();
    this.run = { kind, t0: now, frames: 0, last: now, worst: 0, ghosts: 0 };
  }

  private report() {
    const r = this.run;
    if (!r) return;
    this.run = null;
    if (r.frames > 1) this.onReport?.({ kind: r.kind, ms: Math.round(r.last - r.t0), frames: r.frames, worstFrame: Math.round(r.worst), ghosts: r.ghosts });
  }

  private make(id: string, src: string, w: number, h: number, pose: Pose, mode: Ghost['mode']): Ghost {
    const el = document.createElement('div');
    el.className = 'fx-ghost';
    el.style.width = `${w}px`; el.style.height = `${h}px`;
    const img = document.createElement('img');
    img.src = src; img.alt = ''; img.decoding = 'async';
    const wash = document.createElement('div');
    wash.className = 'fx-wash';
    el.append(img, wash);
    this.host.appendChild(el);
    const g: Ghost = { id, el, img, wash, w, h, pose, blur: 0, wash0: 0, op: 1, flight: null, queue: [], tweens: {}, mode, endAt: 0 };
    this.ghosts.set(id, g);
    if (this.run) this.run.ghosts++;
    this.paint(g);
    return g;
  }

  /** One tween per property; a new one replaces the old and starts from the old one's value at its start time. */
  private tween(g: Ghost, prop: 'blur' | 'wash' | 'op', to: number, t0: number, dur: number, e: Ease) {
    const prev = g.tweens[prop];
    const from = prev ? this.valueAt(prev, t0) : prop === 'blur' ? g.blur : prop === 'wash' ? g.wash0 : g.op;
    g.tweens[prop] = { from, to, t0, dur, e };
  }

  private valueAt(tw: Tween, t: number) {
    if (t <= tw.t0) return tw.from;
    if (tw.dur <= 0) return tw.to;
    return tw.from + (tw.to - tw.from) * tw.e(clamp((t - tw.t0) / tw.dur));
  }

  private burst(at: number, book: DOMRect) {
    const el = this.burstEl;
    el.style.left = `${book.left + book.width / 2 - 20}px`;
    el.style.top = `${book.top + book.height / 2 - 20}px`;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ transform: 'scale(1)', opacity: 0.75 }, { transform: 'scale(9)', opacity: 0 }],
      { duration: 620 * this.slow, delay: Math.max(0, at - performance.now()), easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
  }

  private loop() {
    if (this.raf) return;
    const tick = (now: number) => {
      this.raf = 0;
      if (this.run) {
        const dt = now - this.run.last;
        if (this.run.frames > 0) this.run.worst = Math.max(this.run.worst, dt);
        this.run.frames++; this.run.last = now;
      }
      for (const g of [...this.ghosts.values()]) this.step(g, now);
      if (this.ghosts.size) this.raf = requestAnimationFrame(tick);
      else this.report();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private step(g: Ghost, now: number) {
    while (g.queue.length && now >= g.queue[0].t0) {
      const next = g.queue.shift()!;
      next.from = { ...g.pose };
      g.flight = next;
    }
    const f = g.flight;
    if (f && f.from) {
      const to = f.to();
      if (!to) {
        // The card it was flying to is no longer mounted (a new search, a scroll far away): fade out;
        // ending still "lands" it, so the card shows normally when it is next on screen.
        this.tween(g, 'op', 0, now, 120 * this.slow, ease.lin);
        g.flight = null; g.endAt = now + 120 * this.slow;
      } else {
        const k = clamp((now - f.t0) / f.dur), a = f.eXY(k), b = f.eS(k);
        g.pose = { x: f.from.x + (to.x - f.from.x) * a, y: f.from.y + (to.y - f.from.y) * a, s: f.from.s + (to.s - f.from.s) * b, rot: f.from.rot + (to.rot - f.from.rot) * a };
      }
    }
    for (const prop of ['blur', 'wash', 'op'] as const) {
      const tw = g.tweens[prop];
      if (!tw) continue;
      const v = this.valueAt(tw, now);
      if (prop === 'blur') g.blur = v; else if (prop === 'wash') g.wash0 = v; else g.op = v;
    }
    this.paint(g);
    if (now >= g.endAt && !g.queue.length && (!g.flight || now >= g.flight.t0 + g.flight.dur)) this.end(g);
  }

  private end(g: Ghost) {
    this.ghosts.delete(g.id);
    g.el.remove();
    g.onLand?.();
  }

  private paint(g: Ghost) {
    const p = g.pose;
    g.el.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.rot}deg) scale(${p.s})`;
    g.el.style.opacity = String(g.op);
    g.img.style.filter = g.blur > 0.05 ? `blur(${g.blur}px) saturate(${1 - g.blur / 28})` : '';
    g.wash.style.opacity = String(g.wash0);
  }
}
