import { useState, type ReactNode } from "react";
import { Heart, Trophy, User } from "lucide-react";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import type { Target } from "../bindings/Target";
import { ArtistDialog, ArtistSettingsDialog } from "./ArtistDialog";
import { FollowingDialog } from "./FollowingDialog";

export type SubscriptionKind = "artist" | "ranking" | "bookmarks";

/** 添加流程与订阅设置共用的上下文。 */
type FlowContext = {
  status: SubscriptionStatus;
  safe: boolean;
  /** 现有的订阅（标出已订阅的）。 */
  list: Subscription[];
  /** 默认收进的资料库（当前打开的）。 */
  libraryId: string | null;
  onClose: () => void;
};

export type AddFlowProps = FlowContext & { onAdded: (added: Subscription[]) => void };
export type SettingsFlowProps = FlowContext & { subscription: Subscription; onSaved: (saved: Subscription) => void };

/**
 * 各类订阅在订阅页的挂载点（#369 画师、#370 榜单、#371 收藏夹）。名单按这里的顺序分组；
 * 添加菜单里一项只有给了 `add` 才能用，选了它时订阅页渲染 `add` 给的对话框，关掉时卸下；
 * 名单行的“订阅设置”只在给了 `settings` 时出现。`hiddenWhenSafe` 说明哪条订阅在安全模式下不出现
 * （例如 R-18 榜单，#366），名单与它收进来的图一起隐藏。
 */
export type KindMount = {
  kind: SubscriptionKind;
  icon: (size: number) => ReactNode;
  /** 添加流程：这一类的添加对话框。 */
  add?: (props: AddFlowProps) => ReactNode;
  /** 订阅设置：改一条已有订阅的对话框。 */
  settings?: (props: SettingsFlowProps) => ReactNode;
  hiddenWhenSafe?: (subscription: Subscription) => boolean;
};

/** 画师的添加流程（#369）：订阅画师，可以转到从 pixiv 关注导入，再返回。 */
function ArtistAddFlow(props: AddFlowProps) {
  const [step, setStep] = useState<"artist" | "following">("artist");
  return step === "artist"
    ? <ArtistDialog {...props} onImport={() => setStep("following")} />
    : <FollowingDialog {...props} onBack={() => setStep("artist")} />;
}

const icon = (Icon: typeof User) => (size: number) => <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;

export const KINDS: KindMount[] = [
  {
    kind: "artist", icon: icon(User),
    add: (props) => <ArtistAddFlow {...props} />,
    settings: (props) => <ArtistSettingsDialog {...props} />,
  },
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
