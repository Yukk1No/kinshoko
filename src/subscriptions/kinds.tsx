import type { ReactNode } from "react";
import { Heart, Trophy, User } from "lucide-react";
import type { Subscription } from "../bindings/Subscription";
import type { Target } from "../bindings/Target";

export type SubscriptionKind = "artist" | "ranking" | "bookmarks";

/**
 * 各类订阅在订阅页的挂载点（#369 画师、#370 榜单、#371 收藏夹）。名单按这里的顺序分组；
 * 添加菜单里一项只有给了 `add` 才能用；`hiddenWhenSafe` 说明哪条订阅在安全模式下不出现
 * （例如 R-18 榜单，#366），名单与它收进来的图一起隐藏。
 */
export type KindMount = {
  kind: SubscriptionKind;
  icon: (size: number) => ReactNode;
  /** 添加流程：在订阅页里打开这一类的添加对话框。 */
  add?: () => void;
  hiddenWhenSafe?: (subscription: Subscription) => boolean;
};

const icon = (Icon: typeof User) => (size: number) => <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;

export const KINDS: KindMount[] = [
  { kind: "artist", icon: icon(User) },
  { kind: "ranking", icon: icon(Trophy) },
  { kind: "bookmarks", icon: icon(Heart) },
];

export function kindOf(target: Target): SubscriptionKind {
  switch (target.kind) {
    case "pixivArtist": return "artist";
    case "pixivRanking": return "ranking";
    case "pixivBookmarks": return "bookmarks";
  }
}

/** 安全模式开着时订阅页不显示的订阅。 */
export function hiddenWhenSafe(subscription: Subscription, kinds: KindMount[] = KINDS): boolean {
  const mount = kinds.find((k) => k.kind === kindOf(subscription.target));
  return mount?.hiddenWhenSafe?.(subscription) ?? false;
}
