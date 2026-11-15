import type { TFunction } from "i18next";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import type { Target } from "../bindings/Target";

/** 订阅榜单（#370）可选的榜：pixiv 只有 R-18 日榜与周榜，没有 R-18 月榜。 */
export type RankingKey = "day" | "week" | "month" | "dayExplicit" | "weekExplicit";
export type Ranking = { key: RankingKey; period: RankingPeriod; explicit: boolean };

export const RANKINGS: Ranking[] = [
  { key: "day", period: "day", explicit: false },
  { key: "week", period: "week", explicit: false },
  { key: "month", period: "month", explicit: false },
  { key: "dayExplicit", period: "day", explicit: true },
  { key: "weekExplicit", period: "week", explicit: true },
];

/** 可选的名次（与后端 `RANKING_TOPS` 一致）。 */
export const TOPS = [10, 50, 100] as const;
export type Top = (typeof TOPS)[number];

export function rankingKey(period: RankingPeriod, explicit: boolean): RankingKey {
  return RANKINGS.find((r) => r.period === period && r.explicit === explicit)!.key;
}

/** 名单上的名字（「日榜 前 50」）：按界面语言现拼，名次改了跟着变。 */
export function rankingName(
  t: TFunction<"subscriptions">,
  period: RankingPeriod,
  explicit: boolean,
  top: number,
): string {
  return t("ranking.name", { period: t(`ranking.period.${rankingKey(period, explicit)}`), count: top });
}

/** 订阅在名单、退订确认与订阅设置里显示的名字：榜单与收藏夹按语言现拼，画师用存下的名字。 */
export function displayName(t: TFunction<"subscriptions">, subscription: { name: string; target: Target }): string {
  const { target } = subscription;
  switch (target.kind) {
    case "pixivRanking":
      return rankingName(t, target.period, target.explicit, target.top);
    case "pixivBookmarks":
      return t("bookmarks.name");
    case "pixivArtist":
      return subscription.name;
  }
}
