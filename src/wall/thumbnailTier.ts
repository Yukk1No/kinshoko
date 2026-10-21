// 缩略图档位：与 `crates/kinshoko-core/src/library/thumbnail.rs` 的 `TIERS` 相同，两边一起改。
// 后端把请求的像素取整到档位，图片墙按档位而不是原始像素决定何时重新浏览：同一档位内缩放（#200）时
// 卡片地址不变，不必把全部已加载的卡片重新读一遍。

const TIERS = [128, 192, 256, 384, 512, 768, 1024, 1536, 2048] as const;

/** 不小于 px 的最小档位；超过最大档位时取最大档位。 */
export function thumbnailTier(px: number): number {
  return TIERS.find((tier) => tier >= px) ?? TIERS[TIERS.length - 1];
}
