// 图片墙测试的 `workspace_browse` 回答：只写出卡片的尺寸、占位图与成人标记，其余按一个图库补齐。
import type { BrowsePage } from "../bindings/BrowsePage";
import type { LibraryInfo } from "../bindings/LibraryInfo";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspacePage } from "../bindings/WorkspacePage";

export type CardSeed = { id: string; width: number; height: number; placeholder?: string; adult?: boolean };

/** 只在一个图库里的卡片；`imageId` 与 `id` 相同，缩略图地址因此是 `${libraryId}/${id}/档位`。 */
export function workspaceCard({ id, width, height, placeholder, adult = false }: CardSeed, libraryId = "L1"): WorkspaceCard {
  return {
    id, width, height, adult, libraryId, imageId: id,
    ...(placeholder === undefined ? {} : { placeholder }),
    sources: [{ libraryId, libraryName: libraryId, imageId: id, unavailable: null, matches: true, deleted: false }],
  };
}

export function workspacePage(cards: CardSeed[], total = cards.length, nextCursor: string | null = null, libraryId = "L1"): WorkspacePage {
  return { cards: cards.map((card) => workspaceCard(card, libraryId)), total, nextCursor, status: { revision: "r", libraries: [] } };
}

/** 一页按图库写的卡片（带缩略图地址）换成图片墙的一页：卡片不带缩略图地址，图片墙按来源与档位自己拼（#313）；每张图只有 `owner` 这一个来源。 */
export function wallPage(result: BrowsePage, owner: Pick<LibraryInfo, "id" | "name">, revision = "fixture-0"): WorkspacePage {
  return {
    cards: result.cards.map(({ thumbnail: _, ...card }) => ({ ...card, libraryId: owner.id, imageId: card.id, sources: [{
      libraryId: owner.id, libraryName: owner.name, imageId: card.id, matches: true, unavailable: null, deleted: false,
    }] })),
    nextCursor: result.nextCursor,
    total: result.total,
    status: { revision, libraries: [] },
  };
}
