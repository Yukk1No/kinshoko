import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Artist } from "../bindings/Artist";
import type { NewSubscription } from "../bindings/NewSubscription";
import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { invoke } from "./invoke";

// 订阅（#368）。功能还没做完时（没设 KINSHOKO_SUBSCRIPTIONS=1）这些命令都 reject。

/** 订阅入口与托盘的状态；这一版没有订阅功能时 reject。 */
export function subscriptionStatus(): Promise<SubscriptionStatus> {
  return invoke<SubscriptionStatus>("subscription_status");
}

/** 检查开始或结束、登录变化、新图数量或安全模式变化时推送。 */
export function onSubscriptionStatus(handler: (status: SubscriptionStatus) => void): Promise<UnlistenFn> {
  return listen<SubscriptionStatus>("subscription-status", (e) => handler(e.payload));
}

/** 设置里的订阅开关。 */
export function setSubscriptionsEnabled(on: boolean): Promise<SubscriptionStatus> {
  return invoke<SubscriptionStatus>("set_subscriptions_enabled", { on });
}

/** 立即检查全部订阅（退避中仍不查）。 */
export function subscriptionCheckNow(): Promise<void> {
  return invoke<void>("subscription_check_now");
}

export function subscriptions(): Promise<Subscription[]> {
  return invoke<Subscription[]>("subscriptions");
}

/** 最近收进来的图。`safeMode` 或设置里的安全模式开着时，后端按图库的有效分级去掉成人作品。 */
export function subscriptionRecent(safeMode: boolean): Promise<ReceivedImage[]> {
  return invoke<ReceivedImage[]>("subscription_recent", { safeMode });
}

/** 订阅页看过了：新图标为已看，入口与托盘上的数量清零。 */
export function subscriptionMarkSeen(): Promise<void> {
  return invoke<void>("subscription_mark_seen");
}

/** 打开 pixiv 登录窗口（已开着时把它提到前面）。`title` 是按界面语言给的窗口标题。 */
export function subscriptionLogin(title: string): Promise<void> {
  return invoke<void>("subscription_login", { title });
}

/** 关掉登录窗口，这次登录作废。 */
export function subscriptionCancelLogin(): Promise<SubscriptionStatus> {
  return invoke<SubscriptionStatus>("subscription_cancel_login");
}

export function subscriptionLogout(): Promise<SubscriptionStatus> {
  return invoke<SubscriptionStatus>("subscription_logout");
}

/** 订阅画师（#369）：从画师主页链接或 ID 找到画师。认不出、找不到时 reject（`artistUnrecognized`、`artistNotFound`）。 */
export function subscriptionFindArtist(input: string): Promise<Artist> {
  return invoke<Artist>("subscription_find_artist", { input });
}

/** 登录账号在 pixiv 上关注的画师。 */
export function subscriptionFollowing(): Promise<Artist[]> {
  return invoke<Artist[]>("subscription_following");
}

/** 添加订阅（可以一次几条）；已订阅过的对象 reject（`alreadySubscribed`），一条都不加。 */
export function subscriptionAdd(subscriptions: NewSubscription[]): Promise<Subscription[]> {
  return invoke<Subscription[]>("subscription_add", { subscriptions });
}

/** 改一条订阅收不收漫画与成人作品。 */
export function subscriptionSetOptions(id: string, includeExplicit: boolean, includeManga: boolean): Promise<Subscription> {
  return invoke<Subscription>("subscription_set_options", { id, includeExplicit, includeManga });
}

/** 退订；已收进图库的图留着。 */
export function subscriptionRemove(id: string): Promise<void> {
  return invoke<void>("subscription_remove", { id });
}
