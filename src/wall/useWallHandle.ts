// 图片墙对外的命令（WallHandle）：预览图片大小、作废在途响应、读下一页、全选，以及先移走卡片（#290）。
import { useImperativeHandle } from "react";
import type { Dispatch, Ref, MutableRefObject, SetStateAction } from "react";
import type { BrowserCard, WallHandle } from "./wallShared";

export function useWallHandle({
  ref, measureBeforeReflow, setPreviewDensity, generation, inflight, loadMoreRef, selectAllRef, shownCards, pendingRemoval, setCards, setTotal,
}: {
  ref: Ref<WallHandle> | undefined;
  measureBeforeReflow: (keepSafe?: boolean) => void;
  setPreviewDensity: Dispatch<SetStateAction<number | null>>;
  generation: MutableRefObject<number>;
  inflight: MutableRefObject<number | null>;
  loadMoreRef: MutableRefObject<() => void>;
  selectAllRef: MutableRefObject<() => void>;
  shownCards: MutableRefObject<BrowserCard[]>;
  pendingRemoval: MutableRefObject<Set<string>>;
  setCards: Dispatch<SetStateAction<BrowserCard[]>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
}) {
  useImperativeHandle(ref, () => ({
    previewDensity(value) { measureBeforeReflow(); setPreviewDensity(value); },
    invalidate() { generation.current += 1; inflight.current = null; },
    loadMore() { loadMoreRef.current(); },
    selectAll() { selectAllRef.current(); },
    remove(ids) {
      const removing = new Set(ids);
      /** 移走时墙上每张卡片的位置：放回时按它排回原来的先后。 */
      const rank = new Map(shownCards.current.map((card, index) => [card.id, index]));
      let removed = shownCards.current.filter((card) => removing.has(card.id));
      if (!removed.length) return () => {};
      for (const card of removed) pendingRemoval.current.add(card.id);
      const batch = removed.map((card) => card.id);
      // 还在路上的下一页是按移走前的卡片拼的，回来会把移走的卡片带回来：作废它。整理完的重新浏览会再取。
      generation.current += 1;
      inflight.current = null;
      measureBeforeReflow();
      setCards((now) => now.filter((card) => !removing.has(card.id)));
      setTotal((count) => (count === null ? count : count - removed.length));
      return (failedIds) => {
        // 后端做完了：这批不再算“正在移走”，恢复翻页。
        for (const id of batch) pendingRemoval.current.delete(id);
        const failing = new Set(failedIds);
        const shown = new Set(shownCards.current.map((card) => card.id));
        const returning = removed.filter((card) => failing.has(card.id) && !shown.has(card.id));
        removed = removed.filter((card) => !returning.includes(card));
        if (!returning.length) return;
        generation.current += 1;
        inflight.current = null;
        measureBeforeReflow();
        // 一次归并：放回的卡片按原来的位置，插到原来排在它后面的第一张墙上卡片之前。
        const back = [...returning].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
        setCards((now) => {
          const present = new Set(now.map((card) => card.id));
          const pending = back.filter((card) => !present.has(card.id));
          const next: BrowserCard[] = [];
          let i = 0;
          for (const card of now) {
            const at = rank.get(card.id);
            if (at !== undefined) while (i < pending.length && rank.get(pending[i].id)! < at) next.push(pending[i++]);
            next.push(card);
          }
          next.push(...pending.slice(i));
          return next;
        });
        setTotal((count) => (count === null ? count : count + returning.length));
      };
    },
  }), [measureBeforeReflow, setPreviewDensity, generation, inflight, loadMoreRef, selectAllRef, shownCards, pendingRemoval, setCards, setTotal]);
}
