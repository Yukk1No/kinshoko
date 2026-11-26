import { useTranslation } from "react-i18next";
import { useSubscriptionsContext } from "./useSubscriptions";

/**
 * 在 pixiv 上关注这位画师。关注即订阅（#461 第 6 步）：在订阅页里关注同时订阅，已订阅时写“已关注 · 自动收”。
 * 订阅名单还没读到或不在订阅页里时只看 pixiv 的关注。
 */
export function FollowButton({
  userId,
  followed,
  busy = false,
  onToggle,
}: {
  userId: string;
  followed: boolean;
  /** 正在写：写完之前不再接受点击。 */
  busy?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const subscribed = followed && !!subs?.artist(userId);
  // 订阅名单还没读到时不能点：取消关注时找不到订阅，就会关注取消了却还在自动收。
  // 这位画师的订阅正在退订（例如在“管理”里）时也不能点：关注会看到还没删掉的订阅而不再订阅。
  const removing = subs?.artist(userId);
  const writing =
    busy ||
    !!subs?.pending(`artist:${userId}`) ||
    (!!removing && !!subs?.pending(removing.id)) ||
    (!!subs && !subs.ready);
  return (
    <button type="button" className="k-btn" aria-pressed={followed} disabled={writing} onClick={onToggle}>
      {subscribed ? t("browse.followedSubscribed") : followed ? t("browse.followed") : t("browse.follow")}
    </button>
  );
}
