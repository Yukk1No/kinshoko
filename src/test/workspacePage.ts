// 图片墙测试的 `workspace_browse` 回答：只写出卡片的尺寸、占位图与成人标记，其余按一个图库补齐。
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
