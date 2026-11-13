import type { MutableRefObject } from "react";
import type { ReactNode } from "react";
import { masonry, type Box } from "./layout";
import {type BrowserCard, type WallProps,
} from "./wallShared";
import { wallCardNode, } from "./WallCard";
import { useOpenTray, veiledSheets } from "./imageSets";


// 挂载范围内一张卡片的元素：没变的沿用上次的，原样从 Wall.tsx 移出。

export type RenderedCards = Map<string, { card: BrowserCard; box: Box; chosen: boolean; veiled: boolean; leaving: boolean; landing: boolean; tier: number; language: string; trayPage: number; veiledPages: string; node: ReactNode }>;

type Args = {
  i: number;
  shown: BrowserCard[];
  layout: ReturnType<typeof masonry>;
  safeMode: boolean;
  revealed: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  arriving: ReadonlySet<string>;
  tray: ReturnType<typeof useOpenTray>["tray"];
  renderedCards: { current: RenderedCards };
  nextRendered: RenderedCards;
  tier: number;
  language: string;
  thumbnailPx: number;
  workspaceScope: WallProps["workspaceScope"];
  cardHandlers: Parameters<typeof wallCardNode>[0]["cardHandlers"];
  lastOpened: MutableRefObject<string | null>;
  uiScale: number;
};

export function mountedCardNode({ i, shown, layout, safeMode, revealed, selected, arriving, tray, renderedCards, nextRendered, tier, language, thumbnailPx, workspaceScope, cardHandlers, lastOpened, uiScale }: Args): ReactNode {
        const card = shown[i];
        const b = layout.boxes[i];
        const veiled = card.adult && (safeMode || !revealed.has(card.id));
        const veiledPages = veiledSheets(card, safeMode, revealed);
        // 安全模式下墙上的成人卡片只会是刚开启、等资料库确认的那些：影子已替它飞向封印书，
        // 原地不再留着遮蔽的图，只先占着位置，确认后其余卡片再补位（#154）。
        const leaving = card.adult && safeMode;
        const chosen = selected.has(card.id);
        const landing = arriving.has(card.id);
        // 托盘里的页记下页码（从 1 起）。
        const trayPage = tray && i >= tray.at && i < tray.at + tray.count ? i - tray.at + 1 : 0;
        // 没变的卡片沿用上次的元素，React 跳过整张卡片的比对（#109）。
        const kept = renderedCards.current.get(card.id);
        if (kept && kept.card === card && kept.box === b && kept.chosen === chosen && kept.veiled === veiled && kept.leaving === leaving && kept.landing === landing && kept.tier === tier && kept.language === language && kept.trayPage === trayPage && kept.veiledPages === veiledPages) {
          nextRendered.set(card.id, kept);
          return kept.node;
        }
        const node = wallCardNode({ card, thumbnailPx, b, landing, veiled, leaving, selected, workspaceScope, cardHandlers, lastOpened, trayPage, uiScale, veiledPages });
        nextRendered.set(card.id, { card, box: b, chosen, veiled, leaving, landing, tier, language, trayPage, veiledPages, node });
        return node;
}
