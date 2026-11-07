// 缩略图按滚动方向预取（#109）。
import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { thumbnailUrl } from "../ipc";
import { visible, type masonry } from "./layout";
import { startupWallMounted } from "../startupGate";
import { createPrefetcher, decodeThumbnail, prefetchOrder, type MountWindow } from "./prefetch";
import { cardThumbnail } from "./thumbnailTier";
import { PREFETCH_MAX, PREFETCH_PX, type BrowserCard } from "./wallShared";

export function usePrefetchThumbnails({ layout, mount, cards, scrollDirection, thumbnailPx }: {
  layout: ReturnType<typeof masonry>;
  mount: MountWindow;
  cards: BrowserCard[];
  scrollDirection: MutableRefObject<1 | -1>;
  thumbnailPx: number;
}) {
  // 缩略图按滚动方向预取，离挂载范围近的先取；挂载范围变化时更新（#109）。
  const prefetcher = useRef<ReturnType<typeof createPrefetcher> | null>(null);
  useEffect(() => {
    const prefetch = createPrefetcher({ load: decodeThumbnail });
    prefetcher.current = prefetch;
    return () => { prefetch.dispose(); prefetcher.current = null; };
  }, []);
  useEffect(() => {
    if (!cards.length || mount.bottom <= mount.top) return;
    const order = prefetchOrder(layout, mount, scrollDirection.current, PREFETCH_PX).slice(0, PREFETCH_MAX);
    prefetcher.current?.want(order.map((i) => thumbnailUrl(cardThumbnail(cards[i], thumbnailPx))));
  }, [layout, mount, cards, thumbnailPx]);
  // 启动加载页按首屏真正挂上的卡片数等缩略图（#338）：挂载范围与 Wall.tsx 挂卡片用的同一个。
  useEffect(() => {
    if (cards.length && mount.bottom > mount.top) startupWallMounted(visible(layout, mount.top, mount.bottom).length);
  }, [layout, mount, cards.length]);
}
