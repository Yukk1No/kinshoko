// 缩略图档位：与 `crates/kinshoko-core/src/library/thumbnail.rs` 的 `TIERS` 相同，两边一起改。
// 后端把请求的像素取整到档位。工作区的卡片不带缩略图地址，图片墙按卡片的来源与档位自己拼（#313），
// 换档位不必重新浏览；只浏览单个资料库的旧路径仍由后端给出地址，按档位决定何时重新浏览（#200）。
import type { BrowserCard } from "./wallShared";

const TIERS = [128, 192, 256, 384, 512, 768, 1024, 1536, 2048] as const;

/** 不小于 px 的最小档位；超过最大档位时取最大档位。 */
export function thumbnailTier(px: number): number {
  return TIERS.find((tier) => tier >= px) ?? TIERS[TIERS.length - 1];
}

/** 卡片的缩略图地址（`thumb` 协议的路径）：工作区的卡片按显示用的来源与档位拼出，与后端相同。 */
export function cardThumbnail(card: BrowserCard, px: number): string {
  if (card.thumbnail !== undefined) return card.thumbnail;
  return `${card.libraryId}/${card.imageId}/${thumbnailTier(px)}`;
}
