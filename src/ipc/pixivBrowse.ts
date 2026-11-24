import { convertFileSrc } from "@tauri-apps/api/core";
import type { ArtistsPage } from "../bindings/ArtistsPage";
import type { CollectedWork } from "../bindings/CollectedWork";
import type { Feed } from "../bindings/Feed";
import type { HandReport } from "../bindings/HandReport";
import type { PixivWork } from "../bindings/PixivWork";
import type { SaveDestination } from "../bindings/SaveDestination";
import type { WorksPage } from "../bindings/WorksPage";
import { invoke } from "./invoke";

// 应用内浏览（#461）。和查找画师一样：要开着订阅、登录着、不在退避中，否则 reject（`subscriptionSource`）。
// 界面还没接上，现有订阅页不用这些。

/** 作品流的一页。`next` 为空时读第一页，否则原样交回上一页的 `next`。 */
export function subscriptionBrowse(feed: Feed, next: string | null = null): Promise<WorksPage> {
  return invoke<WorksPage>("subscription_browse", { feed, next });
}

/** 按名字找画师的一页。 */
export function subscriptionSearchArtists(word: string, next: string | null = null): Promise<ArtistsPage> {
  return invoke<ArtistsPage>("subscription_search_artists", { word, next });
}

/**
 * 把一个作品收进资料库：`pages` 为空时收全部页；`again` 为真时已收的页也再收一次（资料库里的图被删掉后）。
 * 作者、标签、来源链接与成人分级同订阅收进来的图；动图不收。
 */
export function subscriptionCollect(
  work: PixivWork,
  destination: SaveDestination,
  pages: number[] | null = null,
  again = false,
): Promise<HandReport> {
  return invoke<HandReport>("subscription_collect", { work, pages, again, destination });
}

/** 这些作品里已收进资料库的页（“已收”标记）。不联网。 */
export function subscriptionCollected(workIds: string[]): Promise<CollectedWork[]> {
  return invoke<CollectedWork[]>("subscription_collected", { workIds });
}

/** pixiv 收藏或取消收藏一个作品（#461 第 5 步）。`private` 只在收藏时有用。取消收藏不动资料库里的图。 */
export function subscriptionSetBookmark(illustId: string, on: boolean, isPrivate: boolean): Promise<void> {
  return invoke<void>("subscription_set_bookmark", { illustId, on, private: isPrivate });
}

/** 在 pixiv 上关注或取消关注一位画师（#461 第 5 步）。只写 pixiv，不增删订阅。 */
export function subscriptionSetFollow(userId: string, on: boolean): Promise<void> {
  return invoke<void>("subscription_set_follow", { userId, on });
}

const IMAGE_HOST = "https://i.pximg.net/";

/** pixiv 图片地址换成后端转发的地址（`pximg` 协议）；不是 pixiv 图片主机上的地址时为空。 */
export function pixivImageSrc(url: string): string | null {
  if (!url.startsWith(IMAGE_HOST)) return null;
  return convertFileSrc("", "pximg") + url.slice(IMAGE_HOST.length);
}
