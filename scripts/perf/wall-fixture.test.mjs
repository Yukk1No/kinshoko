import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fixturePlan, pngImage, writeFixture } from "./wall-fixture.mjs";

describe("fixturePlan", () => {
  it("默认 5000 张，同一种子总得到同一份清单", () => {
    const a = fixturePlan();
    expect(a).toHaveLength(5000);
    expect(fixturePlan()).toEqual(a);
    expect(fixturePlan({ seed: 2 })).not.toEqual(a);
  });

  it("比例覆盖横图、方图、竖图与超过 2.6 的长图，长边在 640–1024", () => {
    const plan = fixturePlan();
    const ratios = plan.map((p) => p.height / p.width);
    expect(Math.min(...ratios)).toBeLessThan(0.6);
    expect(ratios.some((r) => Math.abs(r - 1) < 0.01)).toBe(true);
    expect(Math.max(...ratios)).toBeGreaterThan(2.6);
    for (const p of plan) expect(Math.max(p.width, p.height)).toBeGreaterThanOrEqual(640);
    for (const p of plan) expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1024);
    expect(new Set(plan.map((p) => p.name)).size).toBe(plan.length);
  });
});

describe("pngImage", () => {
  it("写出可解码的 RGB PNG，尺寸与清单一致", () => {
    const bytes = pngImage({ width: 7, height: 5, hue: 120, name: "x.png" });
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(7);
    expect(bytes.readUInt32BE(20)).toBe(5);
    const idat = bytes.indexOf(Buffer.from("IDAT"));
    const length = bytes.readUInt32BE(idat - 4);
    const raw = inflateSync(bytes.subarray(idat + 4, idat + 4 + length));
    expect(raw.length).toBe(5 * (1 + 7 * 3));
  });
});

describe("writeFixture", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("按清单写文件并附上清单，便于核对", () => {
    dir = mkdtempSync(join(tmpdir(), "wall-fixture-"));
    const manifest = writeFixture(dir, { count: 12, maxSide: 64, minSide: 32 });
    const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
    expect(files).toHaveLength(12);
    const saved = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
    expect(saved.count).toBe(12);
    expect(saved.images).toEqual(manifest.images);
    expect(saved.images[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
