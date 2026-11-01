import type { ReceivedImage } from "../bindings/ReceivedImage";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";

// 订阅页测试共用的数据。

export const NOW = Date.UTC(2026, 9, 31, 6, 0);
export const account = { name: "yuki_sub", explicitAllowed: true };

export const status = (patch: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  enabled: true, login: { state: "loggedIn", account }, signingIn: false, checking: false, newCount: 0, backoffUntil: null, ...patch,
});

export const subscription = (id: string, name: string, patch: Partial<Subscription> = {}): Subscription => ({
  id, name, target: { kind: "pixivArtist", userId: id }, libraryId: "L1", includeExplicit: true, includeManga: false,
  createdAt: NOW - 86_400_000, lastCheckedAt: NOW - 10 * 60_000, lastError: null, lastFailedAt: null, ...patch,
});

export const list: Subscription[] = [
  subscription("s1", "Mika"),
  subscription("s2", "灯里", { lastError: { code: "network" }, lastFailedAt: NOW - 60_000 }),
  subscription("s3", "日榜 前 50", { target: { kind: "pixivRanking", period: "day", top: 50 } }),
  subscription("s4", "我的收藏", { target: { kind: "pixivBookmarks" } }),
];

export const received = (imageId: string, patch: Partial<ReceivedImage> = {}): ReceivedImage => ({
  libraryId: "L1", imageId, subscriptionId: "s1", workId: imageId, page: 0, explicit: false, new: false, receivedAt: NOW, ...patch,
});

export const recent: ReceivedImage[] = [
  received("n1", { new: true }),
  received("n2", { new: true, explicit: true }),
  received("n3", { new: true, subscriptionId: "s3" }),
  received("o1"),
  received("o2", { explicit: true, subscriptionId: "s3" }),
];
