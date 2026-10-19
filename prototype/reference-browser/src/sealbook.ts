// The seal book (封印书, #27): geometry and drawing, ported from the chosen design
// (design/seal-book-concepts/round5-a1-round-lock, 24 px master). p = 0 sealed, 1 open.

const f = (n: number) => +n.toFixed(2);
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = {
  lin: (t: number) => t,
  inQ: (t: number) => t * t,
  inC: (t: number) => t * t * t,
  outC: (t: number) => 1 - (1 - t) ** 3,
  inOutC: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (s = 1.7) => (t: number) => { const c = s + 1; return 1 + c * (t - 1) ** 3 + s * (t - 1) ** 2; },
};

/** Toggle durations of the control itself (round 5): release 640 ms, seal 420 ms (same path, reversed). */
export const OPEN_MS = 640;
export const SEAL_MS = 420;

type Page = { sx: number; fx: number; tS: number; tF: number; bS: number; bF: number; r: number; rs: number };

const star = (cx: number, cy: number, r: number, k = 0.16) => {
  const d = r * k;
  return `M${f(cx)} ${f(cy - r)} C${f(cx + d)} ${f(cy - d)} ${f(cx + d)} ${f(cy - d)} ${f(cx + r)} ${f(cy)} `
    + `C${f(cx + d)} ${f(cy + d)} ${f(cx + d)} ${f(cy + d)} ${f(cx)} ${f(cy + r)} `
    + `C${f(cx - d)} ${f(cy + d)} ${f(cx - d)} ${f(cy + d)} ${f(cx - r)} ${f(cy)} `
    + `C${f(cx - d)} ${f(cy - d)} ${f(cx - d)} ${f(cy - d)} ${f(cx)} ${f(cy - r)} Z`;
};
const circ = (cx: number, cy: number, r: number) => `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;
const rrect = (x0: number, y0: number, x1: number, y1: number, r: number) =>
  `M${f(x0 + r)} ${f(y0)} H${f(x1 - r)} A${r} ${r} 0 0 1 ${f(x1)} ${f(y0 + r)} V${f(y1 - r)} A${r} ${r} 0 0 1 ${f(x1 - r)} ${f(y1)} `
  + `H${f(x0 + r)} A${r} ${r} 0 0 1 ${f(x0)} ${f(y1 - r)} V${f(y0 + r)} A${r} ${r} 0 0 1 ${f(x0 + r)} ${f(y0)} Z`;
const page = (P: Page) => {
  const w = P.fx - P.sx, g = Math.sign(w) || 1, aw = Math.abs(w);
  const r = Math.min(P.r, aw / 2), rs = Math.min(P.rs, aw / 2), cx = P.sx + 0.38 * w;
  return `M${f(P.sx)} ${f(P.tS + rs)} Q${f(P.sx)} ${f(P.tS)} ${f(P.sx + g * rs)} ${f(P.tS)} Q${f(cx)} ${f(P.tF)} ${f(P.fx - g * r)} ${f(P.tF)} `
    + `Q${f(P.fx)} ${f(P.tF)} ${f(P.fx)} ${f(P.tF + r)} L${f(P.fx)} ${f(P.bF - r)} Q${f(P.fx)} ${f(P.bF)} ${f(P.fx - g * r)} ${f(P.bF)} `
    + `Q${f(cx)} ${f(P.bF)} ${f(P.sx + g * rs)} ${f(P.bS)} Q${f(P.sx)} ${f(P.bS)} ${f(P.sx)} ${f(P.bS - rs)} Z`;
};

// ---------------------------------------------------------------- 24 px master
// Book: the user's reference simplified — big top-left radius, page strip cut out, a foot under the fore-edge.
// Lock: round body Ø6 + U shackle (outer width 4, stroke 1), logo keyhole, 1-unit halo in the button colour.
const B = { x0: 4, x1: 20, y0: 2, y1: 21, rTL: 4, rTR: 1.5, cb: 16.5, rBR: 1, nx: 19, bt: 19, rBL: 1.5, strip: [6, 17, 17, 19, 1] as const };
const L = { cx: 12, cy: 11, R: 3, h: 1, kh: { hx: 12, hy: 10.6, r: 0.8, a: 0.3, b: 0.5, y1: 13.1 } };
const SH = { w: 4, sw: 1, top: 5 };
const OPEN: Page = { sx: 11, fx: 3, tS: 7.5, tF: 6, bS: 21, bF: 19.5, r: 1.2, rs: 0 };
const MID = 12;
const STAR = { x: 20.8, y: 3.4, r: 3.1, k: 0.24, halo: 1 };

const silhouette = (() => {
  const b = B, rF = (b.y1 - b.bt) / 2;
  return `M${b.x0} ${b.y0 + b.rTL} A${b.rTL} ${b.rTL} 0 0 1 ${b.x0 + b.rTL} ${b.y0} H${b.x1 - b.rTR} A${b.rTR} ${b.rTR} 0 0 1 ${b.x1} ${b.y0 + b.rTR} `
    + `V${f(b.cb - b.rBR)} A${b.rBR} ${b.rBR} 0 0 1 ${f(b.x1 - b.rBR)} ${b.cb} H${b.nx} V${b.bt} H${f(b.x1 - rF)} A${f(rF)} ${f(rF)} 0 0 1 ${f(b.x1 - rF)} ${b.y1} `
    + `H${b.x0 + b.rBL} A${b.rBL} ${b.rBL} 0 0 1 ${b.x0} ${b.y1 - b.rBL} Z`;
})();
const BASE = `${silhouette} ${rrect(B.strip[0], B.strip[2], B.strip[1], B.strip[3], B.strip[4])}`;
const CLOSED: Page = { sx: B.x0, fx: B.x1, tS: B.y0, tF: B.y0, bS: B.cb, bF: B.cb, r: B.rTR, rs: B.rTL };
const OPEN_R: Page = { ...OPEN, sx: 2 * MID - OPEN.sx, fx: 2 * MID - OPEN.fx };

const keyhole = (() => {
  const k = L.kh, s = Math.sqrt(k.r * k.r - k.a * k.a);
  return `M${f(k.hx - k.a)} ${f(k.hy + s)} A${k.r} ${k.r} 0 1 1 ${f(k.hx + k.a)} ${f(k.hy + s)} L${f(k.hx + k.b)} ${k.y1} H${f(k.hx - k.b)} Z`;
})();
const SHACKLE = (() => {
  const a = (SH.w - SH.sw) / 2, cyA = SH.top + SH.sw / 2 + a, edge = L.cy - Math.sqrt(L.R * L.R - a * a);
  return { lx: L.cx - a, d: `M${f(L.cx - a)} ${f(edge + 1.2)} V${f(cyA)} A${f(a)} ${f(a)} 0 0 1 ${f(L.cx + a)} ${f(cyA)} V${f(edge + 0.4)}` };
})();
const BODY = `${circ(L.cx, L.cy, L.R)} ${keyhole}`;
const HALO = circ(L.cx, L.cy, L.R + L.h);

export type SealColours = { ink: string; acc: string; cut: string };
export const SEAL_VARS: SealColours = { ink: 'var(--seal-ink)', acc: 'var(--seal-acc)', cut: 'var(--seal-cut)' };

/** q: 0 = locked, 1 = gone. The shackle pops (right leg leaves the body), swings about the left leg, the lock sinks and shrinks. */
export function lockSVG(q: number, col: SealColours) {
  const press = 1 - 0.06 * Math.sin(Math.PI * seg(q, 0, 0.26));
  const pop = 0.9 * ease.outC(seg(q, 0.13, 0.39));
  const sx = 1 - 2 * ease.inOutC(seg(q, 0.35, 0.7));
  const k = (1 - ease.inQ(seg(q, 0.43, 1))) * press, drop = 1.2 * ease.inQ(seg(q, 0.48, 1)), op = 1 - seg(q, 0.83, 1);
  if (k <= 0.002 || op <= 0) return '';
  const outer = `translate(0 ${f(drop)}) translate(${L.cx} ${L.cy}) scale(${f(k)}) translate(${-L.cx} ${-L.cy})`;
  const sxs = Math.abs(sx) < 0.02 ? 0.02 * (Math.sign(sx) || 1) : sx;
  const shT = `translate(0 ${f(-pop)}) translate(${f(SHACKLE.lx)} 0) scale(${f(sxs)} 1) translate(${f(-SHACKLE.lx)} 0)`;
  return `<g opacity="${f(op)}" transform="${outer}">`
    + `<path d="${SHACKLE.d}" transform="${shT}" fill="none" stroke="${col.cut}" stroke-width="${f(SH.sw + 2 * L.h)}" stroke-linecap="round"/>`
    + `<path d="${HALO}" fill="${col.cut}"/>`
    + `<path d="${SHACKLE.d}" transform="${shT}" fill="none" stroke="${col.acc}" stroke-width="${SH.sw}"/>`
    + `<path d="${BODY}" fill-rule="evenodd" fill="${col.acc}"/></g>`;
}

/** The whole icon at progress p (0 sealed → 1 open), as SVG children of a 0 0 24 24 viewBox. */
export function sealBookSVG(p: number, col: SealColours = SEAL_VARS) {
  const e = ease.inOutC(seg(p, 0.28, 0.86)), e2 = ease.outC(seg(p, 0.3, 0.82));
  const spine = lerp(CLOSED.sx, OPEN.sx, e), w = lerp(CLOSED.fx - CLOSED.sx, Math.abs(OPEN.fx - OPEN.sx), e), lift = 1.3 * Math.sin(Math.PI * e);
  const front: Page = {
    sx: spine, fx: spine + w * Math.cos(Math.PI * e), tS: lerp(CLOSED.tS, OPEN.tS, e), tF: lerp(CLOSED.tF, OPEN.tF, e) - lift,
    bS: lerp(CLOSED.bS, OPEN.bS, e), bF: lerp(CLOSED.bF, OPEN.bF, e) + lift, r: lerp(CLOSED.r, OPEN.r, e), rs: lerp(CLOSED.rs, 0, e),
  };
  const back = Object.fromEntries((Object.keys(CLOSED) as (keyof Page)[]).map((k) => [k, lerp(CLOSED[k], OPEN_R[k], e2)])) as Page;
  let s = '';
  const baseOp = 1 - seg(p, 0.28, 0.42);
  if (baseOp > 0) s += `<path fill-rule="evenodd" fill="${col.ink}" opacity="${f(baseOp)}" d="${BASE}"/>`;
  s += `<path fill="${col.ink}" d="${page(back)}"/>`;
  s += `<path fill="${col.ink}" stroke="${col.cut}" stroke-width="${f(1.3 * Math.min(1, e * 6))}" stroke-linejoin="round" paint-order="stroke" d="${page(front)}"/>`;
  s += lockSVG(clamp(p / 0.46), col);
  const sg = seg(p, 0.66, 1);
  if (sg > 0) {
    const scl = ease.back(1.9)(sg), rot = -70 * (1 - ease.outC(sg)), d = star(STAR.x, STAR.y, STAR.r, STAR.k);
    const tr = `translate(${STAR.x} ${STAR.y}) rotate(${f(rot)}) scale(${f(Math.max(scl, 0))}) translate(${-STAR.x} ${-STAR.y})`;
    s += `<g transform="${tr}" opacity="${f(seg(p, 0.66, 0.74))}"><path d="${d}" fill="${col.cut}" stroke="${col.cut}" stroke-width="${STAR.halo * 2}" stroke-linejoin="round"/><path d="${d}" fill="${col.ink}"/></g>`;
  }
  return s;
}

/** The lock alone, centred in its own box (viewBox 7 4 10 11): the marker on blurred pins and group thumbnails. */
export const LOCK_VIEWBOX = '7 4 10 11';
