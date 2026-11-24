import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { PixivWork } from "../bindings/PixivWork";
import { errorText } from "../ipc";
import { subscriptionSetBookmark, subscriptionSetFollow } from "../ipc/pixivBrowse";
import type { Subscription } from "../bindings/Subscription";
import type { Subscriptions } from "./useSubscriptions";

/** 改回写之前的样子：之前没有覆盖的就去掉覆盖，回到读到的数据。 */
function restore(map: ReadonlyMap<string, boolean>, key: string, before: boolean | undefined) {
  const next = new Map(map);
  if (before === undefined) next.delete(key);
  else next.set(key, before);
  return next;
}

/**
 * 给画师的反馈（#461 第 5 步，#409）：pixiv 收藏与关注。只由画师亲手点，不做任何自动写入。
 * 整页共用一份：在一面墙上点了，别的墙上同一个作品、同一位画师跟着变。点下去先改界面，写失败再改回来并说明。
 *
 * 关注即订阅（#461 第 6 步）：给了订阅名单（`subs`）时，在 pixiv 关注成功后同时在 Kinshoko 订阅这位画师，
 * 取消关注成功后同时退订（已收进资料库的图留着）。pixiv 那边没写成时订阅不动。
 */
export function useFeedback(subs: Subscriptions | null = null) {
  const { t } = useTranslation("subscriptions");
  const [bookmarks, setBookmarks] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [follows, setFollows] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 读回来的作品里带着的关注状态，画师页顶上的“关注”用它。 */
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在写的作品与画师：写完之前不再接受第二次点击，失败时才能准确改回写之前的样子。 */
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const writing = useRef(new Set<string>());
  const begin = useCallback((key: string) => {
    if (writing.current.has(key)) return false;
    writing.current.add(key);
    setPending(new Set(writing.current));
    return true;
  }, []);
  const end = useCallback((key: string) => {
    writing.current.delete(key);
    setPending(new Set(writing.current));
  }, []);

  const learn = useCallback((entries: [userId: string, followed: boolean][]) => {
    setKnown((map) => {
      const fresh = entries.filter(([id]) => !map.has(id));
      if (!fresh.length) return map;
      const next = new Map(map);
      for (const [id, followed] of fresh) next.set(id, followed);
      return next;
    });
  }, []);

  const bookmarked = useCallback((work: PixivWork) => bookmarks.get(work.id) ?? work.bookmarked, [bookmarks]);
  /** 关注了没有；还不知道时为空。 */
  const followed = useCallback(
    (userId: string): boolean | null => follows.get(userId) ?? known.get(userId) ?? null,
    [follows, known],
  );

  /** pixiv 收藏或取消收藏。R-18 作品收成非公开（#461）。写完才回，失败不抛出，只说明。正在写时再点不算。 */
  const setBookmark = useCallback(
    async (work: PixivWork, on: boolean) => {
      const key = `w:${work.id}`;
      if (!begin(key)) return;
      const before = bookmarks.get(work.id);
      setBookmarks((map) => new Map(map).set(work.id, on));
      setNotice(null);
      try {
        await subscriptionSetBookmark(work.id, on, work.explicit);
      } catch (error) {
        setBookmarks((map) => restore(map, work.id, before));
        setNotice(t(on ? "browse.bookmarkFailed" : "browse.unbookmarkFailed", { error: errorText(error) }));
      } finally {
        end(key);
      }
    },
    [t, begin, end, bookmarks],
  );

  const setFollow = useCallback(
    async (artist: Artist, on: boolean, like?: Subscription) => {
      const key = `a:${artist.userId}`;
      if (!begin(key)) return false;
      const before = follows.get(artist.userId);
      setFollows((map) => new Map(map).set(artist.userId, on));
      setNotice(null);
      try {
        try {
          await subscriptionSetFollow(artist.userId, on);
        } catch (error) {
          setFollows((map) => restore(map, artist.userId, before));
          setNotice(t(on ? "browse.followFailed" : "browse.unfollowFailed", { error: errorText(error) }));
          return false;
        }
        // 订阅改完之前这位画师一直锁着：退订还没写完时再点“关注”，会看到旧订阅而不再订阅，退订落地后就成了关注却没订阅。
        if (subs) await (on ? subs.subscribeArtist(artist, like) : subs.unsubscribeArtist(artist.userId));
        return true;
      } finally {
        end(key);
      }
    },
    [t, begin, end, follows, subs],
  );

  const bookmarkPending = useCallback((workId: string) => pending.has(`w:${workId}`), [pending]);
  const followPending = useCallback((userId: string) => pending.has(`a:${userId}`), [pending]);

  return { bookmarked, followed, learn, setBookmark, setFollow, bookmarkPending, followPending, notice };
}

export type Feedback = ReturnType<typeof useFeedback>;

/** 订阅页共用的一份反馈；不在订阅页里（例如单测只挂一面墙）时为空，墙上就不显示关注和取消收藏。 */
export const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedbackContext(): Feedback | null {
  return useContext(FeedbackContext);
}
