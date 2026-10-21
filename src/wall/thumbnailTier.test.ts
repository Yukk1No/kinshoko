import { expect, it } from "vitest";
import rust from "../../crates/kinshoko-core/src/library/thumbnail.rs?raw";
import { thumbnailTier } from "./thumbnailTier";

it("取整到不小于它的最小档位，超过最大档位时取最大档位", () => {
  expect(thumbnailTier(360)).toBe(384);
  expect(thumbnailTier(384)).toBe(384);
  expect(thumbnailTier(385)).toBe(512);
  expect(thumbnailTier(1)).toBe(128);
  expect(thumbnailTier(5000)).toBe(2048);
});

it("档位与后端的 TIERS 相同", () => {
  const tiers = rust.match(/const TIERS: \[u32; \d+\] = \[([^\]]+)\]/)![1].split(",").map(Number);
  for (const tier of tiers) expect(thumbnailTier(tier)).toBe(tier);
  for (const [i, tier] of tiers.entries()) if (i > 0) expect(thumbnailTier(tiers[i - 1] + 1)).toBe(tier);
});
