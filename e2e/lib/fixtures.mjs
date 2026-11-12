// e2e 脚本共用的测试图生成：PNG 块与合成图。只用 Node 自带模块。
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/** PNG 数据块：长度 + 类型 + 数据 + CRC32。 */
export function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** 合成图：两种颜色沿对角线渐变；glow 为真时左上方再叠一团亮斑。写到 path。 */
export function png(path, width, height, [a, b], { glow = true } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      if (glow) {
        const d = Math.hypot(x - width * 0.35, y - height * 0.3) / Math.min(width, height);
        const spot = Math.max(0, 0.45 - d);
        for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.min(255, Math.round(a[c] * (1 - t) + b[c] * t + spot * 200));
      } else {
        for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(a[c] * (1 - t) + b[c] * t);
      }
    }
    rows.push(row);
  }
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(rows))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** 不带亮斑的渐变图，参数同 png。 */
export const gradientPng = (path, width, height, colours) => png(path, width, height, colours, { glow: false });
