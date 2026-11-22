import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionPreview } from "../bindings/SubscriptionPreview";
import { errorText } from "../ipc";
import {
  subscriptionAdd,
  subscriptionPreviews,
  subscriptionRemove,
  subscriptionSetLibrary,
  subscriptions as listSubscriptions,
} from "../ipc/subscriptions";
import { useSaveDestination } from "../library/SaveDestination";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { useOptionalToast } from "../ui/Toast";
import { displayName, rankingName } from "../subscriptions/rankingNames";

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
 * 就地订阅不弹对话框，资料库按这个顺序挑：订阅设置里选的“新订阅收进” → 同类订阅已经在用的 → 应用内浏览上次亲手选的
 * 收图目标 → 第一个可用的资料库。
 *
 * 这次打开订阅页以来取消的订阅记在 `gone` 里（不存盘），画师页可以从那里找回来。`safe` 是安全模式：卡片上的缩略图
 * 按它过滤。
 */
export function useSubscriptions(safe = false) {
  const { t } = useTranslation("subscriptions");
  const { memory } = useSaveDestination();
  const toast = useOptionalToast();
  const libraries = useLibraryOptions();
  const [list, setList] = useState<Subscription[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<Subscription[]>([]);
  const [previews, setPreviews] = useState<ReadonlyMap<string, SubscriptionPreview>>(new Map());
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

  // 名单里的订阅变了（多了、少了）再读一次概况；只是改了设置不用重读。
  const ids = list?.map((s) => s.id).join(",") ?? null;
  useEffect(() => {
    if (ids === null) return;
    let alive = true;
    subscriptionPreviews(safe).then(
      (found) => alive && setPreviews(new Map(found.map((p) => [p.subscriptionId, p]))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [ids, safe]);

  /** 加进名单；又订回来的不再算“已取消订阅的”（不管是撤销、开关还是关注订回来的）。 */
  const added = useCallback((subs: Subscription[]) => {
    setList((l) => [...(l ?? []), ...subs]);
    const keys = new Set(subs.map((sub) => keyOf(sub.target)));
    setGone((g) => g.filter((x) => !keys.has(keyOf(x.target))));
  }, []);
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
      const chosen = memory.subscriptionDestination?.libraryId;
      if (chosen && usable.has(chosen)) return chosen;
      const remembered = memory.pixivDestination?.libraryId;
      return (
        same?.libraryId ??
        (remembered && usable.has(remembered) ? remembered : null) ??
        libraries.options[0]?.value ??
        null
      );
    },
    [list, libraries.options, memory.pixivDestination, memory.subscriptionDestination],
  );

  /** 改一条订阅：同一条正在写时再点不算；失败只说明，不抛出。成功返回 true。 */
  const write = useCallback(
    async (
      key: string,
      run: () => Promise<void>,
      failure: "browse.subscribeFailed" | "browse.unsubscribeFailed" | "browse.libraryFailed",
    ) => {
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
   * 按原来的资料库和收取范围重新订阅（撤销退订、从“已取消订阅的”里找回）：只收之后的新作，不把退订期间的旧作补回来。
   * 已经用开关或“关注”重新订阅了的跳过。
   */
  const again = useCallback(
    (subs: Subscription[]) =>
      write(
        subs.length === 1 ? keyOf(subs[0].target) : "again",
        async () => {
          const back = subs.filter((sub) => !latest.current?.some((s) => keyOf(s.target) === keyOf(sub.target)));
          if (back.length)
            added(
              await subscriptionAdd(
                back.map((sub) => ({
                  target: sub.target,
                  name: sub.name,
                  libraryId: sub.libraryId,
                  includeExplicit: sub.includeExplicit,
                  includeManga: sub.includeManga,
                  backlog: { kind: "newOnly" },
                  ...(sub.target.kind === "pixivBookmarks" && { privateBacklog: { kind: "newOnly" } }),
                })),
              ),
            );
        },
        "browse.subscribeFailed",
      ),
    [write, added],
  );

  /** 删掉一条订阅并记进 `gone`；不给提示。 */
  const drop = useCallback(
    (sub: Subscription) =>
      write(
        sub.id,
        async () => {
          await subscriptionRemove(sub.id);
          removed(sub.id);
          setGone((g) => [sub, ...g.filter((x) => keyOf(x.target) !== keyOf(sub.target))]);
        },
        "browse.unsubscribeFailed",
      ),
    [write, removed],
  );

  /**
   * 退订；`undoable` 时做完给一条带“撤销”的轻提示（界面文字规则：能撤销的不先确认）。画师的退订不动 pixiv 上的关注，
   * 提示里说清楚。
   */
  const unsubscribe = useCallback(
    async (sub: Subscription, undoable = false) => {
      const done = await drop(sub);
      if (done && undoable)
        toast?.show({
          title: t(sub.target.kind === "pixivArtist" ? "browse.unsubscribedArtist" : "browse.unsubscribed", {
            name: sub.name,
          }),
          action: { label: t("browse.undo"), onClick: () => void again([sub]) },
        });
      return done;
    },
    [drop, again, toast, t],
  );

  /** 一次退订几位画师（画师页的批量）：一条提示，撤销把它们一起订回来。 */
  const unsubscribeMany = useCallback(
    async (subs: Subscription[]) => {
      if (subs.length === 1) return unsubscribe(subs[0], true);
      const done: Subscription[] = [];
      for (const sub of subs) if (await drop(sub)) done.push(sub);
      if (done.length)
        toast?.show({
          title: t("browse.unsubscribedMany", { count: done.length }),
          action: { label: t("browse.undo"), onClick: () => void again(done) },
        });
      return done.length === subs.length;
    },
    [unsubscribe, drop, again, toast, t],
  );

  /**
   * 改几条订阅以后收进的资料库（`libraryName` 给提示用，刚新建的库还不在名单里）。做完给带“撤销”的提示，撤销把每条
   * 改回原来的库。已收的图留在原来的库。
   */
  const setLibrary = useCallback(
    async (subs: Subscription[], libraryId: string, libraryName?: string) => {
      const moving = subs.filter((s) => s.libraryId !== libraryId);
      if (!moving.length) return true;
      const apply = async (ids: string[], to: string) => {
        for (const sub of await subscriptionSetLibrary(ids, to)) saved(sub);
      };
      const done = await write(
        "library",
        () =>
          apply(
            moving.map((s) => s.id),
            libraryId,
          ),
        "browse.libraryFailed",
      );
      if (!done) return false;
      const library = libraryName ?? libraries.options.find((o) => o.value === libraryId)?.label ?? "";
      const before = new Map<string, string[]>();
      for (const s of moving) before.set(s.libraryId, [...(before.get(s.libraryId) ?? []), s.id]);
      const [only] = before.keys();
      const old = before.size === 1 ? libraries.options.find((o) => o.value === only)?.label : undefined;
      const kept = old ? t("browse.keptIn", { library: old }) : t("browse.keptInOld");
      toast?.show({
        title:
          moving.length === 1
            ? t("browse.libraryChangedOne", { name: displayName(t, moving[0]), library, kept })
            : t("browse.libraryChangedMany", { count: moving.length, library, kept }),
        action: {
          label: t("browse.undo"),
          onClick: () =>
            void write(
              "library",
              async () => {
                for (const [from, ids] of before) await apply(ids, from);
              },
              "browse.libraryFailed",
            ),
        },
      });
      return true;
    },
    [write, saved, libraries.options, toast, t],
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
    unsubscribeMany,
    again,
    gone,
    previews,
    setLibrary,
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
