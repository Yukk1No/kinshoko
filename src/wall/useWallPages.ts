// 图片墙的分页浏览：从头重新浏览（reload）与读下一页（loadMore）。
import { useCallback, useLayoutEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { workspaceBrowse, isCursorExpired, isLensChanged } from "../ipc";
import { safeTiming } from "../shell/safeTiming";
import type { Anchor } from "./layout";
import { PAGE, type BrowserCard, type BrowsePager } from "./wallShared";
import { startupWallPage } from "../startupGate";
import { markStartup } from "../startupTiming";
import { errorText } from "../ipc/commandError";
import { stackHolding, withoutPages, pagesOf } from "./imageSets";

/** 报上已有占位图时，在原有卡片里往后多看几张：前面新进来几张图时，这一页仍大多报得上。 */
const KNOWN_MARGIN = 100;
/** 修订前进或游标过期重拉时的默认最大拉取张数，避免数千张图串行十几次请求；若视口锚点更靠后则以锚点位置为准。 */
const MAX_RELOAD = PAGE * 4;

export function useWallPages({
  setCards,
  cursor,
  setCursor,
  setTotal,
  setError,
  pager,
  inflight,
  view,
  restoring,
  anchor,
  shownCards,
  publishCards,
  visibleCardId,
  preservedIds,
  measureBeforeReflow,
  releasePage,
  reloadKey,
  loadMoreRef,
  workspaceScope,
  safeMode,
  pendingRemoval,
  stackSets,
  setStacked,
}: {
  setCards: Dispatch<SetStateAction<BrowserCard[]>>;
  cursor: string | null;
  setCursor: Dispatch<SetStateAction<string | null>>;
  setTotal: Dispatch<SetStateAction<number | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  pager: BrowsePager;
  inflight: MutableRefObject<number | null>;
  view: MutableRefObject<{ conditions: ConditionTree; workspaceScope: WorkspaceScope; safeMode: boolean }>;
  restoring: MutableRefObject<boolean>;
  anchor: MutableRefObject<Anchor | null>;
  shownCards: MutableRefObject<BrowserCard[]>;
  /** 原子交付被接受后，在同一批状态更新里把这一页实际会显示的格子交给调用方。 */
  publishCards: MutableRefObject<(cards: BrowserCard[]) => void>;
  /** 此刻视口顶部附近的卡片；锚点图刚被移走时用它代表邻近可见位置。 */
  visibleCardId: () => string | null;
  /** 重新浏览后仍要留在已读前缀里的图（选中项；查看器当前图按 #179 同步进选中）。 */
  preservedIds: MutableRefObject<ReadonlySet<string>>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
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
  /** 同一图集叠成一摞（#418）。 */
  stackSets: boolean;
  /** 叠在一摞里、不占格子的张数（#418）：结果的张数 = 格数 + 它。 */
  setStacked: Dispatch<SetStateAction<number>>;
}) {
  // Keyed by value: re-selecting the same range creates a new but equal object. Clearing on that
  // identity change emptied the wall without the reload below ever running again (T20 r5/r6).
  const workspaceKey = JSON.stringify(workspaceScope);
  const clearedFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadKey): 重新浏览时作废在途请求（卡片保留）
  // biome-ignore lint/correctness/useExhaustiveDependencies(safeMode): 安全模式切换时作废在途请求（卡片保留）
  useLayoutEffect(() => {
    pager.invalidate();
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
  }, [reloadKey, safeMode, workspaceKey, pager, inflight, restoring, setCards, setTotal, setCursor]);

  const reloadTarget = useCallback(() => {
    const shown = shownCards.current;
    const wanted = new Set<string>();
    if (anchor.current?.id) wanted.add(anchor.current.id);
    const visible = visibleCardId();
    if (visible) wanted.add(visible);
    for (const id of preservedIds.current) wanted.add(id);
    let furthest = -1;
    if (wanted.size) {
      for (let i = 0; i < shown.length; i++) {
        const card = shown[i];
        if (wanted.has(card.id) || card.set?.pages.some((page) => wanted.has(page.id))) furthest = i;
      }
    }
    if (furthest >= 0 && shown.length > PAGE) return Math.max(PAGE, Math.min(shown.length, furthest + KNOWN_MARGIN));
    return Math.min(Math.max(shown.length, PAGE), MAX_RELOAD);
  }, [shownCards, anchor, visibleCardId, preservedIds]);

  /** 从头取至少 want 张，一次替换，避免列表闪空。之前还在路上的请求一律作废。 */
  const reload = useCallback(
    async (want: number) => {
      const gen = pager.begin();
      inflight.current = gen;
      const { conditions, workspaceScope, safeMode } = view.current;
      const current = () => pager.current(gen);
      if (!safeMode) safeTiming.mark("rebrowse-start");
      // 墙上已有的占位图（#313）：按内容寻址、永远不变。每页请求报上这一段原有卡片里已有的，
      // 后端只给其余的卡片带，回来后从这里补上；顺序变了的卡片只是多带一次，不会缺。
      const shown = shownCards.current;
      const held = new Map<string, string>();
      for (const card of shown) if (card.placeholder) held.set(card.id, card.placeholder);
      const knownFrom = (start: number) =>
        shown
          .slice(start, start + PAGE + KNOWN_MARGIN)
          .filter((card) => card.placeholder)
          .map((card) => card.id);
      try {
        // 取到一半结果集变了（游标过期）：从头再取，最多几次，仍不稳定才报错。
        for (let attempt = 0; ; attempt++) {
          const next: BrowserCard[] = [];
          let after: string | null = null;
          let count = 0;
          let stacked = 0;
          let acceptedStatus: WorkspaceStatus | null = null;
          try {
            do {
              const page = await workspaceBrowse(
                {
                  scope: workspaceScope,
                  conditions,
                  cursor: after,
                  limit: PAGE,
                  knownPlaceholders: knownFrom(next.length),
                  stackSets,
                },
                safeMode,
              );
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
              stacked = (page.images ?? page.total) - page.total;
              // 恢复位置时一直取到锚定的那张图为止。那张图收在一摞里时（关着叠放时记下的，#418）换成这一摞。
              const target = restoring.current ? anchor.current?.id : undefined;
              const stack = target ? stackHolding(next, target) : null;
              if (stack && stack !== target) anchor.current = { id: stack, delta: 0 };
              if (next.length >= want && !(target && !stack && !next.some((c) => c.id === target))) break;
            } while (after);
          } catch (e) {
            if (current() && isCursorExpired(e) && attempt < 3) continue;
            throw e;
          }
          const pending = pendingRemoval.current;
          if (pending.size) {
            const kept = withoutPages(next, pending);
            stacked -= pagesOf(next).length - pagesOf(kept).length - (next.length - kept.length);
            count -= next.length - kept.length;
            next.splice(0, next.length, ...kept);
          }
          // 送回的还是墙上这些卡片（封印后按节奏先移走了飞走的图）：不量也不重排，正在补位的动画不被打断。
          const prev = shownCards.current;
          const unchanged =
            prev.length === next.length &&
            prev.every((c, i) => c.id === next[i].id && c.width === next[i].width && c.height === next[i].height);
          if (!unchanged) measureBeforeReflow();
          if (!acceptedStatus) return;
          // 原子交付（#742）：修订、卡片与总数一起给浏览结果模块；迟到响应在这里整页丢弃。
          if (!pager.deliver({ token: gen, status: acceptedStatus, cards: next, total: count + stacked })) return;
          publishCards.current(next);
          if (!safeMode) {
            safeTiming.mark("cards-returned");
            releasePage.current = true;
          }
          setCards(next);
          setCursor(after);
          setTotal(count);
          setStacked(stacked);
          setError(null);
          return;
        }
      } catch (e) {
        // 安全模式刚切换、资料库还没跟上（快速开了又关时，第一次确认触发的重新浏览）：不是错误，
        // 卡片原样留着，等资料库确认后的那次重新浏览（与 loadMore 相同）。
        if (current() && !isLensChanged(e)) setError(errorText(e));
      } finally {
        if (inflight.current === gen) inflight.current = null;
      }
    },
    [
      measureBeforeReflow,
      stackSets,
      pager,
      inflight,
      view,
      shownCards,
      publishCards,
      restoring,
      anchor,
      pendingRemoval,
      releasePage,
      setCards,
      setCursor,
      setTotal,
      setStacked,
      setError,
    ],
  );

  const loadMore = useCallback(async () => {
    if (inflight.current !== null || !cursor || pendingRemoval.current.size) return;
    const gen = pager.token();
    inflight.current = gen;
    const { conditions, workspaceScope, safeMode } = view.current;
    let expired = false;
    try {
      const page = await workspaceBrowse(
        { scope: workspaceScope, conditions, cursor, limit: PAGE, knownPlaceholders: [], stackSets },
        safeMode,
      );
      if (!pager.current(gen)) return;
      const next = [...shownCards.current, ...page.cards];
      const stacked = (page.images ?? page.total) - page.total;
      if (!pager.deliver({ token: gen, status: page.status, cards: next, total: page.total + stacked })) return;
      publishCards.current(next);
      // 瀑布流追加时已有卡片的位置不变，不必量旧位置、起重排动画（#109）。
      setCards(next);
      setCursor(page.nextCursor);
      setTotal(page.total);
      setStacked(stacked);
      setError(null);
    } catch (e) {
      if (!pager.current(gen)) return;
      // 结果集变了，接着翻会遗漏或重复：从第一页重读，保持正在看的位置。
      if (isCursorExpired(e)) expired = true;
      else if (!isLensChanged(e)) setError(errorText(e));
    } finally {
      if (inflight.current === gen) inflight.current = null;
    }
    if (expired) void reload(reloadTarget());
  }, [
    shownCards,
    publishCards,
    reloadTarget,
    cursor,
    reload,
    stackSets,
    inflight,
    pendingRemoval,
    pager,
    view,
    setCards,
    setCursor,
    setTotal,
    setStacked,
    setError,
  ]);
  loadMoreRef.current = () => {
    void loadMore();
  };
  // 布局效果：同一次提交里先于其他组件的刷新（被动效果）发出浏览，后端按到达顺序排队（#183）。
  // biome-ignore lint/correctness/useExhaustiveDependencies(reloadKey): reloadKey 变了就从头重新浏览
  useLayoutEffect(() => {
    void reload(reloadTarget());
  }, [reload, reloadTarget, reloadKey]);
  return { loadMore };
}
