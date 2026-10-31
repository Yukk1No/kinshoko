import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

/** 最近收进来的图；安全模式开着时后端已去掉成人作品。 */
export function subscriptionRecent(): Promise<ReceivedImage[]> {
  return invoke<ReceivedImage[]>("subscription_recent");
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
