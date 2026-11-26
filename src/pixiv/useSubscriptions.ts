import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { MovedWork } from "../bindings/MovedWork";
import type { MoveReport } from "../bindings/MoveReport";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { OldImages } from "../bindings/OldImages";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionPreview } from "../bindings/SubscriptionPreview";
import { errorText } from "../ipc";
import {
  subscriptionMoveOld,
  subscriptionOldImages,
  subscriptionPreviews,
  subscriptionSetLibrary,
  subscriptionUndoMove,
} from "../ipc/subscriptions";
import { useSaveDestination } from "../library/SaveDestination";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import {
  acceptAddedLocalSubscriptions,
  acceptSavedLocalSubscriptions,
  addLocalSubscriptions,
  invalidateLocalSubscriptions,
  removeLocalSubscription,
  restoreLocalSubscriptions,
  useLocalSubscriptions,
} from "../subscriptions/subscriptionListMirror";
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

const NO_PREVIEWS: ReadonlyMap<string, SubscriptionPreview> = new Map();
const NO_OLD: ReadonlyMap<string, OldImages[]> = new Map();

/**
 * 订阅页共用的一份订阅名单（#461 第 6、7 步）。画师页、榜单与收藏夹的开关、画师作品页改的
 * 都是它，任一处改了别处立刻跟着变。只读写本机的订阅记录；pixiv 上的关注由 `useFeedback` 写。
 *
 * 就地订阅不弹对话框，资料库按这个顺序挑：订阅设置里选的“新订阅收进” → 同类订阅已经在用的 → 应用内浏览上次亲手选的
 * 收图目标 → 第一个可用的资料库。
 *
 * 这次打开订阅页以来取消的订阅记在 `gone` 里（不存盘），画师页可以从那里找回来。`safe` 是安全模式：卡片上的缩略图
 * 按它过滤。`received` 是后台收图的信号（订阅状态里的新图数、是否在检查），变了就重读收图概况。
 */
export function useSubscriptions(safe = false, received: unknown = null) {
  const { t } = useTranslation("subscriptions");
  const { memory } = useSaveDestination();
  const toast = useOptionalToast();
  const libraries = useLibraryOptions();
  const { value: list, error } = useLocalSubscriptions();
  // 有旧名单时后台重读失败不打断浏览；只有第一份就读不到时才把整页换成失败状态（与迁移前一致）。
  const failed = list ? null : error;
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<Subscription[]>([]);
  /** 收图概况，记着是按哪种安全模式读的：换了模式立刻不用旧的（安全模式打开时不能留着成人作品的缩略图）。 */
  const [loaded, setLoaded] = useState<{ safe: boolean; map: ReadonlyMap<string, SubscriptionPreview> } | null>(null);
  /** 留在旧库、能移过来的图（整理过的不算），按订阅。 */
  const [old, setOld] = useState<ReadonlyMap<string, OldImages[]>>(NO_OLD);
  /** 移过图、撤销过移图：再读一次 `old`。 */
  const [moves, setMoves] = useState(0);
  const writing = useRef(new Set<string>());
  /** 名单的最新一份：撤销提示之类晚些才跑的回调拿到的 `artist` 可能是旧的，订阅前按这一份再看一次。 */
  const latest = useRef(list);
  latest.current = list;

  const retry = useCallback(() => invalidateLocalSubscriptions(), []);

  // 名单里的订阅变了（多了、少了）、后台又收了图（`received` 变了）时再读一次概况；只是改了设置不用重读。
  const ids = list?.map((s) => s.id).join(",") ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies(received): received 与 moves 是重读信号，effect 里不读它们
  // biome-ignore lint/correctness/useExhaustiveDependencies(moves): 移图、撤销移图后卡片上的图换了库
  useEffect(() => {
    if (ids === null) return;
    let alive = true;
    subscriptionPreviews(safe).then(
      (found) => alive && setLoaded({ safe, map: new Map(found.map((p) => [p.subscriptionId, p])) }),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [ids, safe, received, moves]);
  const previews = loaded?.safe === safe ? loaded.map : NO_PREVIEWS;

  // 改了收进的库、移过图、后台又收了图时，再看一次哪些订阅还有图留在旧库。
  const targets = list?.map((s) => `${s.id}:${s.libraryId}`).join(",") ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies(received): received 与 moves 是重读信号，effect 里不读它们
  // biome-ignore lint/correctness/useExhaustiveDependencies(moves): 同上
  useEffect(() => {
    if (targets === null) return;
    let alive = true;
    const subIds = targets ? targets.split(",").map((x) => x.slice(0, x.lastIndexOf(":"))) : [];
    subscriptionOldImages(subIds).then(
      (found) => {
        if (!alive) return;
        const map = new Map<string, OldImages[]>();
        for (const o of found) if (o.movable > 0) map.set(o.subscriptionId, [...(map.get(o.subscriptionId) ?? []), o]);
        setOld(map);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [targets, received, moves]);

  /** 又订回来的不再算“已取消订阅的”（不管是撤销、开关还是关注订回来的）。 */
  const forgetGone = useCallback((subs: Subscription[]) => {
    const keys = new Set(subs.map((sub) => keyOf(sub.target)));
    setGone((g) => g.filter((x) => !keys.has(keyOf(x.target))));
  }, []);
  /** 对话框自己调过后端添加命令时，把结果交进共享镜像。 */
  const added = useCallback(
    (subs: Subscription[]) => {
      acceptAddedLocalSubscriptions(subs);
      forgetGone(subs);
    },
    [forgetGone],
  );
  const saved = useCallback((sub: Subscription) => acceptSavedLocalSubscriptions([sub]), []);

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
      failure: "browse.subscribeFailed" | "browse.unsubscribeFailed" | "browse.libraryFailed" | "browse.moveFailed",
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
      return write(key, async () => forgetGone(await addLocalSubscriptions([make(library)])), "browse.subscribeFailed");
    },
    [libraryFor, write, forgetGone, t],
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
          if (back.length) forgetGone(await restoreLocalSubscriptions(back));
        },
        "browse.subscribeFailed",
      ),
    [write, forgetGone],
  );

  /** 删掉一条订阅并记进 `gone`；不给提示。 */
  const drop = useCallback(
    (sub: Subscription) =>
      write(
        sub.id,
        async () => {
          await removeLocalSubscription(sub);
          setGone((g) => [sub, ...g.filter((x) => keyOf(x.target) !== keyOf(sub.target))]);
        },
        "browse.unsubscribeFailed",
      ),
    [write],
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
  const libraryName = useCallback(
    (id: string) => libraries.options.find((o) => o.value === id)?.label,
    [libraries.options],
  );

  /** 撤销移图：图回到旧库，订阅记录也改回去。 */
  const undoMove = useCallback(
    async (works: MovedWork[]) => {
      await write("library", () => subscriptionUndoMove(works), "browse.moveFailed");
      setMoves((n) => n + 1);
    },
    [write],
  );

  /** 卡片上的“移过来”：把这几条订阅留在旧库、没整理过的图移到现在收进的库。做完给带“撤销”的提示。 */
  const moveOld = useCallback(
    async (subs: Subscription[]) => {
      let report: MoveReport | null = null;
      const done = await write(
        "library",
        async () => {
          report = await subscriptionMoveOld(subs.map((s) => s.id));
        },
        "browse.moveFailed",
      );
      setMoves((n) => n + 1);
      const r = report as MoveReport | null;
      if (!done || !r?.moved) return done;
      toast?.show({
        title: t("browse.movedHere", { count: r.moved, library: libraryName(subs[0].libraryId) ?? "" }),
        action: { label: t("browse.undo"), onClick: () => void undoMove(r.works) },
      });
      return true;
    },
    [write, undoMove, libraryName, toast, t],
  );

  /**
   * 改几条订阅以后收进的资料库（`libraryName` 给提示用，刚新建的库还不在名单里）。已收的图默认一起移过去（整理过的
   * 留在原处），提示上的“留在「旧库」”把图移回去；没有能移的图时，提示带“撤销”，把每条改回原来的库。
   */
  const setLibrary = useCallback(
    async (subs: Subscription[], libraryId: string, newName?: string) => {
      const moving = subs.filter((s) => s.libraryId !== libraryId);
      if (!moving.length) return true;
      const apply = async (ids: string[], to: string) => {
        acceptSavedLocalSubscriptions(await subscriptionSetLibrary(ids, to));
      };
      let report: MoveReport | null = null;
      const done = await write(
        "library",
        async () => {
          const ids = moving.map((s) => s.id);
          await apply(ids, libraryId);
          // 忽略失败：移图没成不算改库失败，图留在旧库，卡片上还能“移过来”。
          report = await subscriptionMoveOld(ids).catch(() => null);
        },
        "browse.libraryFailed",
      );
      setMoves((n) => n + 1);
      if (!done) return false;
      const library = newName ?? libraryName(libraryId) ?? "";
      const before = new Map<string, string[]>();
      for (const s of moving) before.set(s.libraryId, [...(before.get(s.libraryId) ?? []), s.id]);
      const [only] = before.keys();
      const oldName = before.size === 1 ? libraryName(only) : undefined;
      const r = report as MoveReport | null;
      if (r?.moved) {
        const works = r.works;
        toast?.show({
          title:
            moving.length === 1
              ? t("browse.libraryMovedOne", { name: displayName(t, moving[0]), library, count: r.moved })
              : t("browse.libraryMovedMany", { count: moving.length, library, images: r.moved }),
          action: {
            label: oldName ? t("browse.keepIn", { library: oldName }) : t("browse.keepInOld"),
            onClick: () => void undoMove(works),
          },
        });
        return true;
      }
      const kept = oldName ? t("browse.keptIn", { library: oldName }) : t("browse.keptInOld");
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
    [write, libraryName, undoMove, toast, t],
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
          async () => forgetGone(await addLocalSubscriptions([make(like.libraryId)])),
          "browse.subscribeFailed",
        );
      return subscribe(`artist:${who.userId}`, make);
    },
    [subscribe, write, forgetGone],
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
    unsubscribe,
    unsubscribeMany,
    again,
    gone,
    previews,
    old,
    moveOld,
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
