import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { PageSubbar } from "../ui/PageFrame";
import { Segmented } from "../ui/Segmented";
import { ArtistIndex } from "./ArtistIndex";
import { FeedView } from "./FeedView";
import { LibraryChip } from "./LibraryMenu";
import { FollowButton } from "./PixivWall";
import type { Collecting } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";

type Kind = "illust" | "manga";

/**
 * “画师”这个去处（#461 第 4 步）：订阅了的画师（`ArtistIndex`），点一位看这位画师在 pixiv 上的作品。
 * 在这里打开搜索时，搜索框改为原地按名字（或 pixiv ID）筛选名单（`filter`）。
 */
export function ArtistsView({
  safe,
  collecting,
  artist,
  filter = "",
  status,
  onArtist,
  onSettings,
}: {
  safe: boolean;
  status: SubscriptionStatus | null;
  collecting: Collecting;
  /** 按名字筛选名单；空的不筛。 */
  filter?: string;
  /** 正在看的画师；为空时显示名单。 */
  artist: Artist | null;
  onArtist: (artist: Artist | null) => void;
  /** 改一位画师的收取范围（漫画、R-18）。 */
  onSettings?: (subscription: Subscription) => void;
}) {
  return artist ? (
    <ArtistWorks safe={safe} collecting={collecting} artist={artist} onBack={() => onArtist(null)} />
  ) : (
    <ArtistIndex safe={safe} status={status} filter={filter} onArtist={onArtist} onSettings={onSettings} />
  );
}

/** 一位画师在 pixiv 上的作品，从新到旧；插画（含动图）与漫画分开读。 */
function ArtistWorks({
  safe,
  collecting,
  artist,
  onBack,
}: {
  safe: boolean;
  collecting: Collecting;
  artist: Artist;
  onBack: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const [kind, setKind] = useState<Kind>("illust");
  const feedback = useFeedbackContext();
  // 读回来的作品里带着关注状态；还没读到时不显示，免得显示错。
  const following = feedback?.followed(artist.userId) ?? null;
  // 订阅着时旁边写着收进哪个库，点开能换；关注即订阅，取消关注就退订。
  const subscription = useSubscriptionsContext()?.artist(artist.userId);
  return (
    <>
      <PageSubbar className="pw-subbar">
        <button type="button" className="k-btn" onClick={onBack}>
          {t("browse.allArtists")}
        </button>
        <h2 className="k-title pw-subbar-title">{artist.name}</h2>
        {feedback && following !== null && (
          <FollowButton
            userId={artist.userId}
            followed={following}
            busy={feedback.followPending(artist.userId)}
            onToggle={() => void feedback.setFollow(artist, !following)}
          />
        )}
        {subscription && <LibraryChip subscription={subscription} />}
        <Segmented<Kind>
          label={t("browse.artistKind")}
          value={kind}
          onChange={setKind}
          options={[
            { value: "illust", label: t("browse.illust") },
            { value: "manga", label: t("browse.manga") },
          ]}
        />
        <a
          className="k-btn"
          href={`https://www.pixiv.net/users/${encodeURIComponent(artist.userId)}`}
          target="_blank"
          rel="noreferrer"
        >
          {t("browse.openOnPixiv")}
        </a>
      </PageSubbar>
      <FeedView
        feed={{ kind: "artist", userId: artist.userId, manga: kind === "manga" }}
        safe={safe}
        collecting={collecting}
      />
    </>
  );
}
