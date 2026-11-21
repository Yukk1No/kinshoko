import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { PixivWork } from "../bindings/PixivWork";
import { errorText } from "../ipc";
import { subscriptionSetBookmark, subscriptionSetFollow } from "../ipc/pixivBrowse";

/**
 * 给画师的反馈（#461 第 5 步，#409）：pixiv 收藏与关注。只由画师亲手点，不做任何自动写入。
 * 整页共用一份：在一面墙上点了，别的墙上同一个作品、同一位画师跟着变。点下去先改界面，写失败再改回来并说明。
 */
export function useFeedback() {
  const { t } = useTranslation("subscriptions");
  const [bookmarks, setBookmarks] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [follows, setFollows] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 读回来的作品里带着的关注状态，画师页顶上的“关注”用它。 */
  const [known, setKnown] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const bookmarkWrites = useRef(new Map<string, boolean>());

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

  /** pixiv 收藏或取消收藏。R-18 作品收成非公开（#461）。写完才回，失败不抛出，只说明。 */
  const setBookmark = useCallback(
    async (work: PixivWork, on: boolean) => {
      bookmarkWrites.current.set(work.id, on);
      setBookmarks((map) => new Map(map).set(work.id, on));
      setNotice(null);
      try {
        await subscriptionSetBookmark(work.id, on, work.explicit);
      } catch (error) {
        // 期间又点了一次的，以后一次为准。
        if (bookmarkWrites.current.get(work.id) === on) setBookmarks((map) => new Map(map).set(work.id, !on));
        setNotice(t(on ? "browse.bookmarkFailed" : "browse.unbookmarkFailed", { error: errorText(error) }));
      }
    },
    [t],
  );

  const setFollow = useCallback(
    async (artist: Artist, on: boolean) => {
      setFollows((map) => new Map(map).set(artist.userId, on));
      setNotice(null);
      try {
        await subscriptionSetFollow(artist.userId, on);
      } catch (error) {
        setFollows((map) => new Map(map).set(artist.userId, !on));
        setNotice(t(on ? "browse.followFailed" : "browse.unfollowFailed", { error: errorText(error) }));
      }
    },
    [t],
  );

  return { bookmarked, followed, learn, setBookmark, setFollow, notice };
}

export type Feedback = ReturnType<typeof useFeedback>;

/** 订阅页共用的一份反馈；不在订阅页里（例如单测只挂一面墙）时为空，墙上就不显示关注和取消收藏。 */
export const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedbackContext(): Feedback | null {
  return useContext(FeedbackContext);
}
