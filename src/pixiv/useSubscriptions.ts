import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import type { Subscription } from "../bindings/Subscription";
import { errorText } from "../ipc";
import { subscriptionAdd, subscriptionRemove, subscriptions as listSubscriptions } from "../ipc/subscriptions";
import { useSaveDestination } from "../library/SaveDestination";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { useOptionalToast } from "../ui/Toast";
import { rankingName } from "../subscriptions/rankingNames";

/** 就地订阅时同一个目标共用的写入锁：开关、“关注”与撤销提示不会同时给它加两条。 */
function keyOf(target: Subscription["target"]): string {
  switch (target.kind) {
    case "pixivArtist":
      return `artist:${target.userId}`;
    case "pixivRanking":
      return target.explicit ? `ranking:${target.period}:explicit:${target.top}` : `ranking:${target.period}`;
    case "pixivBookmarks":
      return "bookmarks";
  }
}

/** 就地打开榜单开关时收前几名；和“订阅榜单”对话框的默认一样。 */
export const RANKING_TOP = 50;

/**
 * 订阅页共用的一份订阅名单（#461 第 6 步，“关注即订阅”与“管理”页）。画师页、榜单与收藏夹的开关、“管理”页改的
 * 都是它，任一处改了别处立刻跟着变。只读写本机的订阅记录；pixiv 上的关注由 `useFeedback` 写。
 *
 * 就地订阅不弹对话框，资料库按这个顺序挑：同类订阅已经在用的 → 这个入口上次亲手选的收图目标 → 第一个可用的资料库。
 */
export function useSubscriptions() {
  const { t } = useTranslation("subscriptions");
  const { memory } = useSaveDestination();
  const toast = useOptionalToast();
  const libraries = useLibraryOptions();
  const [list, setList] = useState<Subscription[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const writing = useRef(new Set<string>());
  /** 名单的最新一份：撤销提示之类晚些才跑的回调拿到的 `artist` 可能是旧的，订阅前按这一份再看一次。 */
  const latest = useRef(list);
  latest.current = list;

  // biome-ignore lint/correctness/useExhaustiveDependencies(attempt): attempt 是重读信号，effect 里不读它
  useEffect(() => {
    let alive = true;
    setFailed(null);
    listSubscriptions().then(
      (next) => alive && setList(next),
      (e) => alive && setFailed(e ?? "error"),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const added = useCallback((subs: Subscription[]) => setList((l) => [...(l ?? []), ...subs]), []);
  const saved = useCallback((sub: Subscription) => setList((l) => l?.map((s) => (s.id === sub.id ? sub : s)) ?? l), []);
  const removed = useCallback((id: string) => setList((l) => l?.filter((s) => s.id !== id) ?? l), []);

  const artist = useCallback(
    (userId: string) => list?.find((s) => s.target.kind === "pixivArtist" && s.target.userId === userId),
    [list],
  );
  const ranking = useCallback(
    (period: RankingPeriod) =>
      list?.find((s) => s.target.kind === "pixivRanking" && s.target.period === period && !s.target.explicit),
    [list],
  );
  const bookmarks = useCallback(() => list?.find((s) => s.target.kind === "pixivBookmarks"), [list]);

  /** 新订阅放进哪个资料库；一个可用的都没有时为空。 */
  const libraryFor = useCallback(
    (kind: Subscription["target"]["kind"]) => {
      const usable = new Set(libraries.options.map((o) => o.value));
      const same = [...(list ?? [])].reverse().find((s) => s.target.kind === kind && usable.has(s.libraryId));
      const remembered = memory.pixivDestination?.libraryId;
      return (
        same?.libraryId ??
        (remembered && usable.has(remembered) ? remembered : null) ??
        libraries.options[0]?.value ??
        null
      );
    },
    [list, libraries.options, memory.pixivDestination],
  );

  /** 改一条订阅：同一条正在写时再点不算；失败只说明，不抛出。成功返回 true。 */
  const write = useCallback(
    async (key: string, run: () => Promise<void>, failure: "browse.subscribeFailed" | "browse.unsubscribeFailed") => {
      if (writing.current.has(key)) return false;
      writing.current.add(key);
      setPending(new Set(writing.current));
      setNotice(null);
      try {
        await run();
        return true;
      } catch (error) {
        setNotice(t(failure, { error: errorText(error) }));
        return false;
      } finally {
        writing.current.delete(key);
        setPending(new Set(writing.current));
      }
    },
    [t],
  );

  const subscribe = useCallback(
    async (key: string, make: (libraryId: string) => NewSubscription) => {
      const kind = make("").target.kind;
      const library = libraryFor(kind);
      if (!library) {
        setNotice(t("browse.noLibrary"));
        return false;
      }
      return write(key, async () => added(await subscriptionAdd([make(library)])), "browse.subscribeFailed");
    },
    [libraryFor, write, added, t],
  );

  /**
   * 退订；`undoable` 时做完给一条带“撤销”的轻提示（界面文字规则：能撤销的不先确认）。撤销按原来的资料库和收取范围
   * 重新订阅，只收之后的新作，不把退订期间的旧作补回来。
   */
  const unsubscribe = useCallback(
    async (sub: Subscription, undoable = false) => {
      const done = await write(
        sub.id,
        async () => {
          await subscriptionRemove(sub.id);
          removed(sub.id);
        },
        "browse.unsubscribeFailed",
      );
      if (done && undoable)
        toast?.show({
          // 画师的退订不动 pixiv 上的关注，提示里说清楚，免得以为连关注也取消了。
          title: t(sub.target.kind === "pixivArtist" ? "browse.unsubscribedArtist" : "browse.unsubscribed", {
            name: sub.name,
          }),
          action: {
            label: t("browse.undo"),
            onClick: () =>
              void write(
                keyOf(sub.target),
                async () => {
                  // 撤销前已经用开关或“关注”重新订阅了的，不再加一条。
                  if (latest.current?.some((s) => keyOf(s.target) === keyOf(sub.target))) return;
                  added(
                    await subscriptionAdd([
                      {
                        target: sub.target,
                        name: sub.name,
                        libraryId: sub.libraryId,
                        includeExplicit: sub.includeExplicit,
                        includeManga: sub.includeManga,
                        backlog: { kind: "newOnly" },
                        ...(sub.target.kind === "pixivBookmarks" && { privateBacklog: { kind: "newOnly" } }),
                      },
                    ]),
                  );
                },
                "browse.subscribeFailed",
              ),
          },
        });
      return done;
    },
    [write, removed, added, toast, t],
  );

  /**
   * 订阅一位画师：只收之后的新作，漫画不收，R-18 照收（和“订阅画师”对话框的默认一样）。给了 `like`（撤销取消关注时
   * 原来那条订阅）就照它的资料库与收取范围。已订阅时什么都不做。
   */
  const subscribeArtist = useCallback(
    async (who: Artist, like?: Subscription) => {
      if (latest.current?.some((s) => s.target.kind === "pixivArtist" && s.target.userId === who.userId)) return true;
      const make = (libraryId: string): NewSubscription => ({
        target: { kind: "pixivArtist", userId: who.userId },
        name: who.name,
        libraryId,
        includeExplicit: like?.includeExplicit ?? true,
        includeManga: like?.includeManga ?? false,
        backlog: { kind: "newOnly" },
      });
      if (like)
        return write(
          `artist:${who.userId}`,
          async () => added(await subscriptionAdd([make(like.libraryId)])),
          "browse.subscribeFailed",
        );
      return subscribe(`artist:${who.userId}`, make);
    },
    [subscribe, write, added],
  );

  /** 退订一位画师；按最新一份名单找（关注的写入发出时名单可能还没读到或已经变了）。 */
  const unsubscribeArtist = useCallback(
    async (userId: string) => {
      const sub = latest.current?.find((s) => s.target.kind === "pixivArtist" && s.target.userId === userId);
      return sub ? unsubscribe(sub) : true;
    },
    [unsubscribe],
  );

  /** 榜单开关（全年龄）：打开时收前 50 名，榜上已有的也收（和对话框一样）。 */
  const setRanking = useCallback(
    async (period: RankingPeriod, on: boolean) => {
      const sub = ranking(period);
      if (!on) return sub ? unsubscribe(sub, true) : true;
      if (sub) return true;
      return subscribe(`ranking:${period}`, (libraryId) => ({
        target: { kind: "pixivRanking", period, top: RANKING_TOP, explicit: false },
        name: rankingName(t, period, false, RANKING_TOP),
        libraryId,
        includeExplicit: true,
        includeManga: false,
        backlog: { kind: "all" },
      }));
    },
    [ranking, unsubscribe, subscribe, t],
  );

  /** 收藏夹开关：公开与非公开收藏一起同步，打开之后新收藏的才收。 */
  const setBookmarks = useCallback(
    async (on: boolean) => {
      const sub = bookmarks();
      if (!on) return sub ? unsubscribe(sub, true) : true;
      if (sub) return true;
      return subscribe("bookmarks", (libraryId) => ({
        target: { kind: "pixivBookmarks" },
        name: "",
        libraryId,
        includeExplicit: true,
        includeManga: false,
        backlog: { kind: "newOnly" },
        privateBacklog: { kind: "newOnly" },
      }));
    },
    [bookmarks, unsubscribe, subscribe],
  );

  /** 名单和可用的资料库都读到了：之前不能就地订阅，否则会把“还没读到资料库”当成“没有资料库”。 */
  const ready = !!list && libraries.ready;

  const isPending = useCallback((key: string) => pending.has(key), [pending]);

  return {
    list,
    ready,
    failed,
    retry,
    notice,
    artist,
    ranking,
    bookmarks,
    added,
    saved,
    removed,
    unsubscribe,
    subscribeArtist,
    unsubscribeArtist,
    setRanking,
    setBookmarks,
    pending: isPending,
  };
}

export type Subscriptions = ReturnType<typeof useSubscriptions>;

/** 订阅页共用的一份订阅名单；不在订阅页里时为空。 */
export const SubscriptionsContext = createContext<Subscriptions | null>(null);

export function useSubscriptionsContext(): Subscriptions | null {
  return useContext(SubscriptionsContext);
}
