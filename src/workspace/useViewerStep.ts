import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { BrowserCard, WallHandle } from "../wall/Wall";

export function useViewerStep({ viewing, setViewing, loadedCards, resultCount, wall }: {
  viewing: BrowserCard | null;
  setViewing: Dispatch<SetStateAction<BrowserCard | null>>;
  loadedCards: BrowserCard[];
  resultCount: number | null;
  wall: RefObject<WallHandle | null>;
}) {
  /** 查看器里的上一张 / 下一张按图片墙的顺序走；走过已读到的卡片时先读下一页，读到后再换图。 */
  const viewingIndex = viewing ? loadedCards.findIndex((card) => card.id === viewing.id) : -1;
  const pendingStep = useRef<{ from: string; index: number } | null>(null);
  const step = (delta: -1 | 1) => {
    const index = viewingIndex + delta;
    const next = loadedCards[index];
    if (next) { pendingStep.current = null; setViewing(next); return; }
    if (delta === 1 && viewing && index < (resultCount ?? 0)) {
      pendingStep.current = { from: viewing.id, index };
      wall.current?.loadMore();
    }
  };
  useEffect(() => {
    const pending = pendingStep.current;
    if (!pending) return;
    // 换了图、关了查看器或结果变了：放弃这次等待。
    if (viewing?.id !== pending.from || loadedCards[pending.index - 1]?.id !== pending.from) { pendingStep.current = null; return; }
    const next = loadedCards[pending.index];
    if (next) { pendingStep.current = null; setViewing(next); }
  }, [loadedCards, viewing]);

  return { viewingIndex, step };
}
