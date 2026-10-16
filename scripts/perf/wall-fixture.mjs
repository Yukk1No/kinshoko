// #102 T7：生成瀑布流帧时间基线用的 5000 张合成参考图。同一种子每次得到逐字节相同的文件。
//
// 用法：node scripts/perf/wall-fixture.mjs <输出目录> [张数=5000] [种子=1]
// 之后在 Kinshoko 里新建一个图库，用“导入 ▸ 整个文件夹”导入该目录（见 docs/implementation/spec-102-t07.md）。
// 图片是渐变加斜纹，长边 640–1024，压缩后每张约几十 KB；比例覆盖横图、方图、竖图与超过 2.6 的长图。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/** 高宽比（高 / 宽）与出现权重。 */
const RATIOS = [
  [0.5, 1], [0.5625, 2], [0.75, 3], [1, 3], [1.333, 4], [1.5, 4], [1.778, 2], [2, 1], [3, 0.5],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成清单：每张图的文件名、宽、高与色相。 */
export function fixturePlan({ count = 5000, seed = 1, minSide = 640, maxSide = 1024 } = {}) {
  const random = mulberry32(seed);
  const totalWeight = RATIOS.reduce((sum, [, w]) => sum + w, 0);
  const pickRatio = () => {
    let x = random() * totalWeight;
    for (const [ratio, weight] of RATIOS) if ((x -= weight) < 0) return ratio;
    return 1;
  };
  return Array.from({ length: count }, (_, i) => {
    const ratio = pickRatio();
    const long = Math.round(minSide + random() * (maxSide - minSide));
    const [width, height] = ratio >= 1 ? [Math.max(1, Math.round(long / ratio)), long] : [long, Math.max(1, Math.round(long * ratio))];
    return { name: `wall-${String(i + 1).padStart(5, "0")}.png`, width, height, hue: Math.floor(random() * 360) };
  });
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

/** 一张渐变加斜纹的 8 位 RGB PNG。 */
export function pngImage({ width, height, hue }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const [r0, g0, b0] = hsl(hue, 0.55, 0.3 + 0.45 * (y / Math.max(1, height - 1)));
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const stripe = ((x + y) >> 4) & 1 ? 18 : 0;
      const o = row + 1 + x * 3;
      raw[o] = Math.min(255, r0 + stripe);
      raw[o + 1] = Math.min(255, g0 + stripe);
      raw[o + 2] = Math.min(255, b0 + stripe);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 写出全部图片与 fixture.json（含每张的 SHA-256）。 */
export function writeFixture(dir, options = {}) {
  mkdirSync(dir, { recursive: true });
  const plan = fixturePlan(options);
  const images = plan.map((item) => {
    const bytes = pngImage(item);
    writeFileSync(join(dir, item.name), bytes);
    return { ...item, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const manifest = { generator: "scripts/perf/wall-fixture.mjs", seed: options.seed ?? 1, count: images.length, images };
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , out, count = "5000", seed = "1"] = process.argv;
  if (!out) {
    console.error("用法：node scripts/perf/wall-fixture.mjs <输出目录> [张数=5000] [种子=1]");
    process.exit(2);
  }
  const manifest = writeFixture(resolve(out), { count: Number(count), seed: Number(seed) });
  const bytes = manifest.images.reduce((sum, i) => sum + i.bytes, 0);
  console.log(`已写出 ${manifest.count} 张（${(bytes / 1e6).toFixed(1)} MB）到 ${resolve(out)}`);
}
