// spec78-frontend.mjs 的测试图生成：最小的 PNG 编码器。
import { deflateSync } from "node:zlib";
import { chunk } from "./lib/fixtures.mjs";

// 例外（#521）：这张图的尺寸、颜色规则与 lib/fixtures.mjs 的 png 不同，合并会改变测试图的像素，所以留在本地。
export function png(w, h, colour) {
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgb = typeof colour === "function" ? colour(x, y) : colour;
    const at = y * (w * 3 + 1) + 1 + x * 3;
    pixels[at] = rgb[0]; pixels[at + 1] = rgb[1]; pixels[at + 2] = rgb[2];
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
