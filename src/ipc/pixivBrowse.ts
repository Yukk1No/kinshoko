import { convertFileSrc } from "@tauri-apps/api/core";
import type { ArtistsPage } from "../bindings/ArtistsPage";
import type { Feed } from "../bindings/Feed";
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

const IMAGE_HOST = "https://i.pximg.net/";

/** pixiv 图片地址换成后端转发的地址（`pximg` 协议）；不是 pixiv 图片主机上的地址时为空。 */
export function pixivImageSrc(url: string): string | null {
  if (!url.startsWith(IMAGE_HOST)) return null;
  return convertFileSrc("", "pximg") + url.slice(IMAGE_HOST.length);
}
