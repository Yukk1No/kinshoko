// 门槛实验的色彩计算：display-p3 canvas 读回的编码值 → CIE Lab（D50）→ ΔE2000。
// 与 Rust 侧 `fidelity::gate` 的 Lab 一致（D50、Bradford 适应），可直接与样本标称值比较。

export type Lab = [number, number, number];

const srgbEotf = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// Display P3（D65）→ XYZ，再经 Bradford 适应到 D50。
const P3_TO_XYZ_D65 = [
  [0.4865709486482162, 0.2656676931690931, 0.198217285234362],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0.0, 0.0451133818589026, 1.043944368900976],
];
const D65_TO_D50 = [
  [1.0479298208405488, 0.0229467933410191, -0.0501922295431356],
  [0.0296278156881593, 0.990434484573249, -0.0170738250293851],
  [-0.0092430581525912, 0.0150551448965779, 0.7518742899580008],
];
const WHITE_D50 = [0.9642, 1.0, 0.8249];

const mul = (m: number[][], v: number[]) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

/** display-p3 编码值（0～1）→ Lab（D50）。 */
export function p3ToLab([r, g, b]: [number, number, number]): Lab {
  const xyz = mul(D65_TO_D50, mul(P3_TO_XYZ_D65, [r, g, b].map(srgbEotf)));
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = xyz.map((v, i) => f(v / WHITE_D50[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000（Sharma 2005）。 */
export function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dl = l2 - l1;
  const dc = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * rad) / 2);
  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBar = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBar = (h1p + h2p + 360) / 2;
    else hBar = (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PatchMean {
  rgb: [number, number, number];
  alpha: number;
}

/** 像素区域的平均编码值与 alpha（0～1）。`scale` 把原图坐标换算到这张图。 */
export function patchMean(
  data: { width: number; data: ArrayLike<number> },
  rect: Rect,
  scale = 1,
): PatchMean {
  const x0 = Math.ceil(rect.x * scale);
  const y0 = Math.ceil(rect.y * scale);
  const x1 = Math.floor((rect.x + rect.width) * scale);
  const y1 = Math.floor((rect.y + rect.height) * scale);
  const sum = [0, 0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * data.width + x) * 4;
      for (let c = 0; c < 4; c++) sum[c] += data.data[i + c];
      n++;
    }
  }
  if (n === 0) throw new Error("色块为空");
  const [r, g, b, a] = sum.map((s) => s / n / 255);
  return { rgb: [r, g, b], alpha: a };
}
