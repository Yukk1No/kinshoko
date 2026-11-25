import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { Candidate } from "../bindings/Candidate";
import type { RatingCandidate } from "../bindings/RatingCandidate";
import { useUiLang } from "../i18n";
import { ratingCandidates, searchCandidates, workspaceCandidates, workspaceLibraryCandidates } from "../ipc";

export const LIMIT = 8;
const CANDIDATE_DEBOUNCE_MS = 80;

/**
 * 候选的身份（#76）：资料库、浏览视角（安全模式）、词表代次与输入的文字。候选只在身份与
 * 当前相同时显示；切换安全模式、词表变化或换了资料库后，旧候选这一帧就不再显示，迟到的
 * 响应也写不回来。后端按同一视角核对（`LensChanged`）。
 */
export type Lens = {
  libraryId: string;
  safe: boolean;
  generation: number;
  workspace?: boolean /** 给这个资料库的图挑标签：封印按全部来源算（#425）。 */;
  picking?: boolean;
};
type Found = { key: string; list: Candidate[] };
export const lensKey = (lens: Lens, text: string) =>
  JSON.stringify([lens.libraryId, lens.safe, lens.generation, lens.workspace, lens.picking, text]);

/** 按 `lens` 与 `text` 取得候选；身份变了的旧结果不返回。标签整理面板挑标签时也用它。 */
export function useCandidates(lens: Lens, text: string, keep: (c: Candidate) => boolean = () => true): Candidate[] {
  return useCandidateState(lens, text, keep).list;
}

/**
 * 同 `useCandidates`，另外给出这段文字的候选是否已经取到（`ready`），没取到时不说“没有匹配”。
 * `limit`：最多取几个；调用方之后还要去掉一些（例如已经有的标签）时多取几个补上。
 */
export function useCandidateState(
  lens: Lens,
  text: string,
  keep: (c: Candidate) => boolean = () => true,
  limit = LIMIT,
): { list: Candidate[]; ready: boolean } {
  const [found, setFound] = useState<Found>({ key: "", list: [] });
  const lang = useUiLang();
  const key = lensKey(lens, text) + `#${limit}#${lang}`;
  const { libraryId, safe } = lens;
  const prevText = useRef(text);
  const filterKept = useEffectEvent((list: Candidate[]) => list.filter((c) => keep(c)));
  useEffect(() => {
    const debounced = prevText.current !== text;
    let alive = true;
    if (!text.trim()) {
      prevText.current = text;
      return;
    }
    const run = () => {
      prevText.current = text;
      (lens.picking
        ? workspaceLibraryCandidates(libraryId, text, lang, limit, safe)
        : lens.workspace
          ? workspaceCandidates(text, lang, limit, safe)
          : searchCandidates(libraryId, text, lang, limit, safe)
      ).then(
        (list) => alive && setFound({ key, list: filterKept(list) }),
        () => alive && setFound({ key, list: [] }),
      );
    };
    if (!debounced) {
      run();
      return () => {
        alive = false;
      };
    }
    const timer = setTimeout(run, CANDIDATE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, libraryId, safe, text, limit, lang, lens.picking, lens.workspace]);
  const ready = found.key === key && !!text.trim();
  return { list: ready ? found.list : [], ready };
}

type FoundRatings = { key: string; list: RatingCandidate[] };

/** 按 `lens` 与 `text` 取得分级候选（#161）；身份变了的旧结果不返回，安全模式切换的这一刻同样作废。 */
export function useRatingCandidates(lens: Lens, text: string): RatingCandidate[] {
  const [found, setFound] = useState<FoundRatings>({ key: "", list: [] });
  const key = lensKey(lens, text);
  const { safe } = lens;
  const prevText = useRef(text);
  useEffect(() => {
    const debounced = prevText.current !== text;
    let alive = true;
    if (!text.trim()) {
      prevText.current = text;
      return;
    }
    const run = () => {
      prevText.current = text;
      ratingCandidates(text, safe).then(
        (list) => alive && setFound({ key, list }),
        () => alive && setFound({ key, list: [] }),
      );
    };
    if (!debounced) {
      run();
      return () => {
        alive = false;
      };
    }
    const timer = setTimeout(run, CANDIDATE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, safe, text]);
  return found.key === key && text.trim() ? found.list : [];
}
