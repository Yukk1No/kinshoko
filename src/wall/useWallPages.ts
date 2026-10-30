// 图片墙的分页浏览：从头重新浏览（reload）与读下一页（loadMore）。
import { useCallback, useLayoutEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { workspaceBrowse, isCursorExpired, isLensChanged } from "../ipc";
import { safeTiming } from "../shell/safeTiming";
import type { Anchor } from "./layout";
import { PAGE, type BrowserCard } from "./wallShared";
import { startupWallPage } from "../startupGate";
import { markStartup } from "../startupTiming";

/** 报上已有占位图时，在原有卡片里往后多看几张：前面新进来几张图时，这一页仍大多报得上。 */
const KNOWN_MARGIN = 100;

export function useWallPages({
  cards, setCards, cursor, setCursor, setTotal, setError, generation, inflight, view, restoring, anchor, shownCards,
  measureBeforeReflow, onWorkspaceStatus, releasePage, reloadKey, loadMoreRef, workspaceScope, safeMode,
  pendingRemoval,
}: {
  cards: BrowserCard[];
  setCards: Dispatch<SetStateAction<BrowserCard[]>>;
  cursor: string | null;
  setCursor: Dispatch<SetStateAction<string | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  generation: MutableRefObject<number>;
  inflight: MutableRefObject<number | null>;
  view: MutableRefObject<{ conditions: ConditionTree; workspaceScope: WorkspaceScope; safeMode: boolean }>;
  restoring: MutableRefObject<boolean>;
  anchor: MutableRefObject<Anchor | null>;
  shownCards: MutableRefObject<BrowserCard[]>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
  onWorkspaceStatus: ((status: WorkspaceStatus, cards: BrowserCard[]) => void) | undefined;
  releasePage: MutableRefObject<boolean>;
  reloadKey: number;
  loadMoreRef: MutableRefObject<() => void>;
  workspaceScope: WorkspaceScope;
  safeMode: boolean;
  /**
   * 先移走、后端还没做完的卡片（#290）。这期间不翻下一页（接着翻会拿旧游标与删前的张数）；
   * 重新浏览回来的页去掉它们，张数也减去页里还算着的那些。
   */
  pendingRemoval: MutableRefObject<Set<string>>;
}) {
  // Keyed by value: re-selecting the same range creates a new but equal object. Clearing on that
  // identity change emptied the wall without the reload below ever running again (T20 r5/r6).
  const workspaceKey = JSON.stringify(workspaceScope);
  const clearedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    generation.current += 1;
    inflight.current = null;
    // 只是修订号前进（自动打标每写一张图一次，#142）或安全模式切换：保留旧卡片，等新的一页回来原地替换。
    // 安全模式开启的那一刻成人卡片已原地遮蔽，封印动画从它们飞出（#154），资料库确认后它们才离开。
    // 浏览范围变了才清空，不露出旧范围的内容。
    if (clearedFor.current === workspaceKey) return;
    clearedFor.current = workspaceKey;
    // Emptying the canvas clamps browser scrollTop. Preserve the user's anchor
    // until the new authorized page restores it.
    restoring.current = true;
    setCards([]);
    setTotal(null);
    setCursor(null);
  }, [reloadKey, safeMode, workspaceKey]);
  const loaded = useRef(0);
  loaded.current = cards.length;

  /** 从头取至少 want 张，一次替换，避免列表闪空。之前还在路上的请求一律作废。 */
  const reload = useCallback(
    async (want: number) => {
      const gen = ++generation.current;
      inflight.current = gen;
      const { conditions, workspaceScope, safeMode } = view.current;
      const current = () => gen === generation.current;
      if (!safeMode) safeTiming.mark("开始重新浏览");
      // 墙上已有的占位图（#313）：按内容寻址、永远不变。每页请求报上这一段原有卡片里已有的，
      // 后端只给其余的卡片带，回来后从这里补上；顺序变了的卡片只是多带一次，不会缺。
      const shown = shownCards.current;
      const held = new Map<string, string>();
      for (const card of shown) if (card.placeholder) held.set(card.id, card.placeholder);
      const knownFrom = (start: number) => shown.slice(start, start + PAGE + KNOWN_MARGIN)
        .filter((card) => card.placeholder).map((card) => card.id);
      try {
        // 取到一半结果集变了（游标过期）：从头再取，最多几次，仍不稳定才报错。
        for (let attempt = 0; ; attempt++) {
          const next: BrowserCard[] = [];
          let after: string | null = null;
          let count = 0;
          let acceptedStatus: WorkspaceStatus | null = null;
          try {
            do {
              const page = await workspaceBrowse({ scope: workspaceScope, conditions, cursor: after, limit: PAGE, knownPlaceholders: knownFrom(next.length) }, safeMode);
              if (!current()) return;
              markStartup("wallFirstPage");
              startupWallPage(page.cards.length);
              acceptedStatus = page.status;
              for (const card of page.cards) {
                const kept = card.placeholder ? undefined : held.get(card.id);
                next.push(kept ? { ...card, placeholder: kept } : card);
              }
              after = page.nextCursor;
              count = page.total;
              // 恢复位置时一直取到锚定的那张图为止。
              const target = restoring.current ? anchor.current?.id : undefined;
              if (next.length >= want && !(target && !next.some((c) => c.id === target))) break;
            } while (after);
          } catch (e) {
            if (current() && isCursorExpired(e) && attempt < 3) continue;
            throw e;
          }
          const pending = pendingRemoval.current;
          if (pending.size) {
            const kept = next.filter((card) => !pending.has(card.id));
            count -= next.length - kept.length;
            next.splice(0, next.length, ...kept);
          }
          // 送回的还是墙上这些卡片（封印后按节奏先移走了飞走的图）：不量也不重排，正在补位的动画不被打断。
          const prev = shownCards.current;
          const unchanged = prev.length === next.length
            && prev.every((c, i) => c.id === next[i].id && c.width === next[i].width && c.height === next[i].height);
          if (!unchanged) measureBeforeReflow();
          // 顺序契约（#324）：先报这一页带回的状态，再交出卡片。状态若要求修剪选择，修剪就落在这一页上。
          if (acceptedStatus) onWorkspaceStatus?.(acceptedStatus, next);
          if (!safeMode) { safeTiming.mark("卡片送回"); releasePage.current = true; }
          setCards(next);
          setCursor(after);
          setTotal(count);
          setError(null);
          return;
        }
      } catch (e) {
        // 安全模式刚切换、资料库还没跟上（快速开了又关时，第一次确认触发的重新浏览）：不是错误，
        // 卡片原样留着，等资料库确认后的那次重新浏览（与 loadMore 相同）。
        if (current() && !isLensChanged(e)) setError(String(e));
      } finally {
        if (inflight.current === gen) inflight.current = null;
      }
    },
    [measureBeforeReflow, onWorkspaceStatus],
  );

  const loadMore = useCallback(async () => {
    if (inflight.current !== null || !cursor || pendingRemoval.current.size) return;
    const gen = generation.current;
    inflight.current = gen;
    const { conditions, workspaceScope, safeMode } = view.current;
    let expired = false;
    try {
      const page = await workspaceBrowse({ scope: workspaceScope, conditions, cursor, limit: PAGE, knownPlaceholders: [] }, safeMode);
      if (gen !== generation.current) return;
      const next = [...cards, ...page.cards];
      onWorkspaceStatus?.(page.status, next);
      // 瀑布流追加时已有卡片的位置不变，不必量旧位置、起重排动画（#109）。
      setCards(next);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (gen !== generation.current) return;
      // 结果集变了，接着翻会遗漏或重复：从第一页重读，保持正在看的位置。
      if (isCursorExpired(e)) expired = true;
      else if (!isLensChanged(e)) setError(String(e));
    } finally {
      if (inflight.current === gen) inflight.current = null;
    }
    if (expired) void reload(Math.max(loaded.current, PAGE));
  }, [cards, cursor, reload, onWorkspaceStatus]);
  loadMoreRef.current = () => { void loadMore(); };
  // 布局效果：同一次提交里先于其他组件的刷新（被动效果）发出浏览，后端按到达顺序排队（#183）。
  useLayoutEffect(() => {
    void reload(Math.max(loaded.current, PAGE));
  }, [reload, reloadKey]);
  return { loadMore };
}
