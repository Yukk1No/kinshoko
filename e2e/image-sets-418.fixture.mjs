// #418 截图用的合成 Eagle 资料库：几个 pixiv 多页作品（链接是作品页、文件名带 _p<n>），夹着普通单张。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { chunk } from "./lib/fixtures.mjs";

const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};
/** 合成图：两种颜色沿对角线渐变，一块亮斑，同一作品的各页色相相近。`seed` 让每张图内容都不同（导入按内容去重）。 */
// 例外（#521）：这张图的尺寸、颜色规则与 lib/fixtures.mjs 的 png 不同，合并会改变测试图的像素，所以留在本地。
function png(width, height, hue, seed) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const [a, b, c] = [hsl(hue, 0.45, 0.62), hsl((hue + 30) % 360, 0.38, 0.36), hsl((hue + 40) % 360, 0.5, 0.85)];
  const cx = 0.2 + ((seed * 0.137) % 0.6),
    cy = 0.25 + ((seed * 0.293) % 0.5);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const d = Math.hypot(x / width - cx, (y / height - cy) * 1.3);
      const glow = Math.max(0, 1 - d / 0.28);
      for (let k = 0; k < 3; k++)
        row[1 + x * 3 + k] = Math.round((a[k] * (1 - t) + b[k] * t) * (1 - glow) + c[k] * glow);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 作品：页数、首页比例（高 / 宽）与各页比例的偏差，与纸张对比原型的那一批相同。 */
const WORKS = [
  { id: "91000001", ratio: 1.0, vary: [0, 0], hue: 140 },
  { id: "91000002", ratio: 0.72, vary: [0, 0.12, 0], hue: 275 },
  { id: "91000003", ratio: 1.414, vary: [0, 0.14, -0.12, 0, 0.1, 0], hue: 205 },
  { id: "91000004", ratio: 1.42, vary: [0, 0, 0.18, 0.12, 0, 0, -0.2, 0, 0, 0, 0.24, 0], hue: 22 },
  { id: "91000005", ratio: 1.6, vary: [0, -0.16, 0.12, 0], hue: 340 },
  { id: "91000006", ratio: 0.56, vary: [0, 0.1, 0, -0.06, 0], hue: 50 },
];
const SINGLE_RATIOS = [0.66, 0.75, 1, 1.25, 1.33, 1.414, 1.5, 0.56, 1.2, 0.8, 1.1, 1.6];
const ORDER = "s A s B C s D s s E F s s s s s".split(" ");

/** 在 `work/fixture` 下写出资料库，返回它的路径与条目数。 */
export function buildFixture(work) {
  const eagle = join(work, "fixture", "示例.library");
  mkdirSync(join(eagle, "images"), { recursive: true });
  writeFileSync(join(eagle, "metadata.json"), JSON.stringify({ folders: [], applicationVersion: "4.0.0" }));
  let serial = 0;
  let btime = 1756571097667;
  function item({ name, width, height, hue, page, url }) {
    const id = `ITEM${String(serial++).padStart(9, "0")}`;
    const dir = join(eagle, "images", `${id}.info`);
    mkdirSync(dir, { recursive: true });
    const bytes = png(width, height, hue, serial + page);
    writeFileSync(join(dir, `${name}.png`), bytes);
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        id,
        name,
        ext: "png",
        size: bytes.length,
        width,
        height,
        tags: [],
        folders: [],
        annotation: "",
        url,
        isDeleted: false,
        btime: (btime += 60_000),
        comments: [],
      }),
    );
  }
  {
    let single = 0,
      work = 0;
    for (const token of ORDER) {
      if (token === "s") {
        const ratio = SINGLE_RATIOS[single % SINGLE_RATIOS.length];
        item({
          name: `single-${++single}`,
          width: 360,
          height: Math.round(360 * ratio),
          hue: (single * 47) % 360,
          page: single,
          url: "",
        });
      } else {
        const w = WORKS[work++];
        w.vary.forEach((v, p) =>
          item({
            name: `${w.id}_p${p}`,
            width: 360,
            height: Math.round(360 * w.ratio * (1 + v)),
            hue: w.hue + (p % 3) * 9 - 9,
            page: p,
            url: `https://www.pixiv.net/artworks/${w.id}`,
          }),
        );
      }
    }
  }
  return { eagle, items: serial };
}
