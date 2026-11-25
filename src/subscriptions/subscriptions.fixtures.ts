import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";

// 订阅页测试共用的数据。

export const NOW = Date.UTC(2026, 9, 31, 6, 0);
export const account = { userId: "1", name: "yuki_sub", explicitAllowed: true, avatar: "" };

export const status = (patch: Partial<SubscriptionStatus> = {}): SubscriptionStatus => ({
  enabled: true,
  login: { state: "loggedIn", account },
  signingIn: false,
  checking: false,
  newCount: 0,
  backoffUntil: null,
  ...patch,
});

export const subscription = (id: string, name: string, patch: Partial<Subscription> = {}): Subscription => ({
  id,
  name,
  target: { kind: "pixivArtist", userId: id },
  libraryId: "L1",
  includeExplicit: true,
  includeManga: false,
  backlog: { kind: "newOnly" },
  since: null,
  skipped: 0,
  createdAt: NOW - 86_400_000,
  lastCheckedAt: NOW - 10 * 60_000,
  lastError: null,
  lastFailedAt: null,
  ...patch,
});

export const list: Subscription[] = [
  subscription("s1", "Mika"),
  subscription("s2", "灯里", { lastError: { code: "network" }, lastFailedAt: NOW - 60_000 }),
  subscription("s3", "日榜 前 50", { target: { kind: "pixivRanking", period: "day", top: 50, explicit: false } }),
  subscription("s4", "我的收藏", { target: { kind: "pixivBookmarks" } }),
];
