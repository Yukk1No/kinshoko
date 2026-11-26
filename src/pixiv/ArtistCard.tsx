import { useRef, type MouseEvent, type Ref } from "react";
import { Check, FolderInput, MoreHorizontal, SlidersHorizontal, UserMinus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionPreview } from "../bindings/SubscriptionPreview";
import { thumbnailUrl } from "../ipc";
import { failureText } from "../subscriptions/checkStatus";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuSubmenu } from "../ui/Menu";
import { Tip } from "../ui/Tip";
import { useOptionalToast } from "../ui/Toast";
import { WarnIcon } from "../ui/WarnIcon";
import { COVERS, useRemoteCovers } from "./artistCovers";
import { artistId, DAY, type ArtistIndexCard } from "./artistIndexShared";
import { LibraryChoices, useLibraryChange } from "./LibraryMenu";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";

/** 卡片缩略图的档位（`thumbnailTier` 的一档）。 */
const COVER_PX = 256;

export function ResubscribeButton({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const toast = useOptionalToast();
  return (
    <button
      type="button"
      className="k-btn is-sm"
      disabled={!subs || subs.pending("again") || subs.pending(`artist:${artistId(subscription)}`)}
      onClick={async () => {
        if (await subs?.again([subscription]))
          toast?.show({ title: t("browse.resubscribed", { name: subscription.name }) });
      }}
    >
      {t("browse.resubscribe")}
    </button>
  );
}

/** 一位画师的卡片：缩略图、名字、多久没有新图、收进哪个库、⋯。已取消订阅的变淡，换成“重新订阅”。 */
export function ArtistCard({
  card,
  safe,
  selecting,
  picked,
  onPick,
  onOpen,
  onSettings,
}: {
  card: ArtistIndexCard;
  safe: boolean;
  selecting: boolean;
  picked: boolean;
  onPick: (range: boolean) => void;
  onOpen: () => void;
  onSettings?: (subscription: Subscription) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const { artist: a, subscription, preview, gone } = card;
  const subs = useSubscriptionsContext();
  const feedback = useFeedbackContext();
  const libraries = useLibraryOptions();
  const toast = useOptionalToast();
  const local = preview?.images ?? [];
  const remote = useRemoteCovers(a.userId, safe, !local.length);
  const covers = local.length
    ? local.map((i) => thumbnailUrl(`${i.libraryId}/${i.imageId}/${COVER_PX}`))
    : remote.covers;
  const library = libraries.options.find((o) => o.value === subscription.libraryId)?.label;
  const change = useLibraryChange(() => [subscription]);
  /** 撤销提示晚些才点：用那时的反馈，不用取消关注那一刻的（那一刻的订阅名单里还有这位画师）。 */
  const latestFeedback = useRef(feedback);
  latestFeedback.current = feedback;
  const unfollow = async () => {
    if (!feedback) return void subs?.unsubscribe(subscription, true);
    if (!(await feedback.setFollow(a, false))) return;
    toast?.show({
      title: t("browse.unfollowedArtist", { name: a.name }),
      action: { label: t("browse.undo"), onClick: () => void latestFeedback.current?.setFollow(a, true, subscription) },
    });
  };
  const open = (event: MouseEvent) => (selecting && !gone ? onPick(event.shiftKey) : onOpen());
  const writing = !!subs?.pending(subscription.id) || !!feedback?.followPending(a.userId);
  const oldHere = subs?.old.get(subscription.id);
  const oldCount = oldHere?.reduce((sum, o) => sum + o.movable, 0) ?? 0;
  const oldLibrary = oldHere && libraries.options.find((o) => o.value === oldHere[0].libraryId)?.label;

  return (
    <li className={`pw-artist-cell${picked ? " is-picked" : ""}${gone ? " is-gone" : ""}`}>
      <button
        type="button"
        className="pw-artist-cover"
        ref={remote.ref as Ref<HTMLButtonElement>}
        aria-label={
          selecting && !gone ? t("browse.pickArtist", { name: a.name }) : t("browse.viewWorksOf", { name: a.name })
        }
        onClick={open}
      >
        {Array.from({ length: COVERS }, (_, i) => (
          <span key={i} className="pw-artist-thumb">
            {covers[i] && <img src={covers[i]} alt="" loading="lazy" decoding="async" draggable={false} />}
          </span>
        ))}
      </button>
      {!gone && (
        <label className="pw-artist-pick">
          <input
            type="checkbox"
            checked={picked}
            aria-label={t("browse.pickArtist", { name: a.name })}
            onChange={() => {}}
            onClick={(event) => onPick(event.shiftKey)}
          />
          <Check size={12} aria-hidden="true" />
        </label>
      )}
      <div className="pw-artist-meta">
        <button type="button" className="pw-artist-name k-name" onClick={open}>
          {a.name}
        </button>
        {/* 上次检查没完成（例如被限流）时先说这件事，原因在悬停提示里。 */}
        {!gone && subscription.lastError ? (
          <Tip label={failureText(subscription.lastError)}>
            <span className="k-list-desc is-warn pw-artist-warn" tabIndex={0}>
              <WarnIcon />
              {t("lastFailed")}
            </span>
          </Tip>
        ) : (
          <span className="k-description">
            {gone ? t("browse.unsubscribedShort") : lastNewText(t, preview, subscription.createdAt)}
          </span>
        )}
      </div>
      {!gone && oldHere && (
        <div className="pw-artist-old">
          <span className="k-description">
            {oldHere.length === 1 && oldLibrary ? (
              <>
                <span>{t("browse.oldImagesIn", { count: oldCount })}</span>
                <span className="k-name">{oldLibrary}</span>
              </>
            ) : (
              t("browse.oldImagesElsewhere", { count: oldCount })
            )}
          </span>
          <button
            type="button"
            className="k-btn is-sm is-quiet"
            disabled={writing || !library}
            aria-label={t("browse.moveHereOf", { name: a.name, count: oldCount, library: library ?? "" })}
            onClick={() => void subs?.moveOld([subscription])}
          >
            {t("browse.moveHere")}
          </button>
        </div>
      )}
      <div className="pw-artist-foot">
        {gone ? (
          <ResubscribeButton subscription={subscription} />
        ) : (
          <>
            <span className="k-description pw-artist-library">
              {library ? (
                <>
                  <span>{t("browse.savesInto")}</span>
                  <span className="k-name">{library}</span>
                </>
              ) : (
                t("browse.savesIntoMissing")
              )}
            </span>
            <Menu.Root>
              <Menu.Trigger
                className="k-icon-btn is-sm pw-artist-more"
                aria-label={t("browse.artistMore", { name: a.name })}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </Menu.Trigger>
              <MenuPopup label={t("browse.artistMore", { name: a.name })} align="end">
                <MenuSubmenu icon={<FolderInput size={14} />} label={t("browse.changeLibrary")} meta={library}>
                  <LibraryChoices current={subscription.libraryId} onPick={change.pick} onCreate={change.create} />
                </MenuSubmenu>
                {onSettings && (
                  <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => onSettings(subscription)}>
                    {t("browse.collectRange")}
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem disabled={writing} onClick={() => void subs?.unsubscribe(subscription, true)}>
                  {t("browse.unsubscribeKeepFollow")}
                </MenuItem>
                <MenuItem icon={<UserMinus size={14} />} danger disabled={writing} onClick={() => void unfollow()}>
                  {t("browse.unfollowArtist")}
                </MenuItem>
              </MenuPopup>
            </Menu.Root>
          </>
        )}
      </div>
      {change.dialog}
    </li>
  );
}

/** “今天有新图”“12 天前有新图”“3 个月没有新图”“订阅 5 个月，还没有新图”“订阅后还没有新图”。 */
function lastNewText(
  t: ReturnType<typeof useTranslation<"subscriptions">>["t"],
  preview: SubscriptionPreview | undefined,
  subscribedAt: number,
) {
  const at = preview?.lastReceivedAt;
  if (at == null) {
    // 订阅很久了还没收到过：说出多久，免得以为是刚订阅的。
    const months = Math.floor((Date.now() - subscribedAt) / DAY / 30);
    return months >= 2 ? t("browse.noNewForMonths", { count: months }) : t("browse.noNewYet");
  }
  const days = Math.floor((Date.now() - at) / DAY);
  if (days < 1) return t("browse.newToday");
  if (days < 60) return t("browse.newDaysAgo", { count: days });
  return t("browse.quietMonths", { count: Math.floor(days / 30) });
}
