import { useCallback, useEffect, useRef, useState } from "react";
import type { Feed } from "../bindings/Feed";
import type { PixivWork } from "../bindings/PixivWork";
import { subscriptionBrowse } from "../ipc/pixivBrowse";

/** 一条作品流读到哪了。 */
export type FeedState = {
  works: PixivWork[];
  /** 正在读下一页。 */
  loading: boolean;
  /** 上一次读页失败的原因；再读一页时清掉。 */
  error: unknown;
  /** 读到底了。 */
  done: boolean;
};

const EMPTY: FeedState = { works: [], loading: false, error: null, done: false };

/**
 * 应用内浏览（#461）的一条作品流：第一页在挂上时读，之后由 `more` 往下翻。同一个作品只留第一次出现的
 * （推荐流翻页时偶尔重复）。`limit` 给了时读够这么多页就算到底。`feed` 为空时什么都不读。
 */
export function usePixivFeed(
  feed: Feed | null,
  limit: number | null = null,
): FeedState & { more: () => void; retry: () => void } {
  const [state, setState] = useState<FeedState>(EMPTY);
  const next = useRef<string | null>(null);
  const pages = useRef(0);
  const busy = useRef(false);
  /** 换了作品流时加一，之前发出的请求回来也不再用。 */
  const generation = useRef(0);
  /** 已经开始读的作品流；子组件的副作用先于这里的重置运行，换流之前的 `more` 不算数。 */
  const active = useRef<string | null>(null);
  const key = feed ? JSON.stringify(feed) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies(feed): 按内容比较，`key` 就是 `feed` 的内容；对象本身每次渲染都是新的
  const load = useCallback(() => {
    if (!feed || busy.current || active.current !== key) return;
    const gen = generation.current;
    busy.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    subscriptionBrowse(feed, next.current).then(
      (page) => {
        if (gen !== generation.current) return;
        busy.current = false;
        pages.current += 1;
        next.current = page.next;
        const done = page.next === null || (limit !== null && pages.current >= limit);
        setState((s) => {
          const seen = new Set(s.works.map((w) => w.id));
          const fresh = page.works.filter((w) => !seen.has(w.id) && seen.add(w.id));
          return { works: [...s.works, ...fresh], loading: false, error: null, done };
        });
      },
      (error: unknown) => {
        if (gen !== generation.current) return;
        busy.current = false;
        setState((s) => ({ ...s, loading: false, error }));
      },
    );
  }, [key, limit]);

  useEffect(() => {
    generation.current += 1;
    active.current = key;
    next.current = null;
    pages.current = 0;
    busy.current = false;
    setState(EMPTY);
    if (key !== null) load();
  }, [key, load]);

  const latest = useRef(state);
  latest.current = state;
  const more = useCallback(() => {
    const s = latest.current;
    if (!s.done && !s.loading && s.error === null) load();
  }, [load]);

  return { ...state, more, retry: load };
}
