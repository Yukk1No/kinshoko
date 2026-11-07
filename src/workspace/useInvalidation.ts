import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { BrowserCard, WallHandle } from "../wall/Wall";
import { decide, initialInvalidation, type Decision, type InvalidationEvent } from "./invalidation";

export type Invalidate = (event: InvalidationEvent) => Decision;

/**
 * 执行失效决策（见 invalidation.ts）：各处只报发生了什么，撤销、关闭、修剪、重读与刷新词表在这里统一做。
 * 返回的决定给调用方处理自己的部分（例如是否采用这份状态快照）。
 */
export function useInvalidation({ wall, loadedCards, setViewing, setSelected, setSources, setReloadKey, setVocabularyKey }: {
  wall: RefObject<WallHandle | null>;
  loadedCards: BrowserCard[];
  setViewing: Dispatch<SetStateAction<BrowserCard | null>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setSources: Dispatch<SetStateAction<WorkspaceCard | null>>;
  setReloadKey: Dispatch<SetStateAction<number>>;
  setVocabularyKey: Dispatch<SetStateAction<number>>;
}) {
  const state = useRef(initialInvalidation);
  const cards = useRef(loadedCards);
  cards.current = loadedCards;
  const invalidate = useCallback<Invalidate>((event) => {
    const outcome = decide(state.current, event);
    state.current = outcome.state;
    const d = outcome.decision;
    if (d.revokeWall) wall.current?.invalidate();
    if (d.closeViewer) setViewing(null);
    if (d.clearSources) setSources(null);
    if (d.clearSelection) setSelected(new Set());
    if (d.pruneSelection) {
      const present = new Set(cards.current.map((card) => card.id));
      setSelected((previous) => {
        const kept = [...previous].filter((id) => present.has(id));
        return kept.length === previous.size ? previous : new Set(kept);
      });
    }
    if (d.reload) setReloadKey((k) => k + 1);
    if (d.refreshVocabulary) setVocabularyKey((k) => k + 1);
    return d;
  }, []);
  /** 当前观察序号：状态读取发出时记下，交回 `statusObserved` 的 `startedAt`。 */
  const observations = useCallback(() => state.current.observations, []);
  return { invalidate, observations };
}
