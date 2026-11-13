import { useEffect, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { BrowserCard, WallHandle } from "../wall/Wall";
import { pagesOf } from "../wall/imageSets";

export function useViewerStep({ viewing, setViewing, loadedCards, resultCount, wall }: {
  viewing: BrowserCard | null;
  setViewing: Dispatch<SetStateAction<BrowserCard | null>>;
  loadedCards: BrowserCard[];
  resultCount: number | null;
  wall: RefObject<WallHandle | null>;
}) {
  /**
   * 查看器里的上一张 / 下一张按图片墙的顺序走；走过已读到的卡片时先读下一页，读到后再换图。
   * 叠成一摞的图集（#418）按它的各页走：先在这一摞里翻，翻完接着墙上的下一格，往回同理。墙上一摞只占一格，
   * 查看器的序号与张数（resultCount）仍按每一张图算。一摞里只有这次浏览能显示的页（符合查找、不被安全模式藏起），
   * 被藏的页不进序号与张数。
   */
  const sequence = useMemo(() => pagesOf(loadedCards), [loadedCards]);
  const viewingIndex = viewing ? sequence.findIndex((card) => card.id === viewing.id) : -1;
  const pendingStep = useRef<{ from: string; index: number } | null>(null);
  const step = (delta: -1 | 1) => {
    const index = viewingIndex + delta;
    const next = sequence[index];
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
    if (viewing?.id !== pending.from || sequence[pending.index - 1]?.id !== pending.from) { pendingStep.current = null; return; }
    const next = sequence[pending.index];
    if (next) { pendingStep.current = null; setViewing(next); }
  }, [sequence, viewing, setViewing]);

  return { viewingIndex, step, loaded: sequence.length };
}
