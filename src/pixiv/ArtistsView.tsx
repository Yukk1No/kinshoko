import { useMemo, useState } from "react";
import { MoreHorizontal, SlidersHorizontal, UserMinus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { Menu, MenuItem, MenuLabel, MenuPopup, MenuSeparator } from "../ui/Menu";
import { useOptionalToast } from "../ui/Toast";
import { Segmented } from "../ui/Segmented";
import { TARGET } from "../wall/wallShared";
import { FeedView } from "./FeedView";
import { PixivStatus } from "./Status";
import { FollowButton } from "./PixivWall";
import type { Collecting } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";

type Kind = "illust" | "manga";

/**
 * “画师”这个去处（#461 第 4 步）：订阅了的画师，点一位看这位画师在 pixiv 上的作品。名单只读本机的订阅，不联网。
 * 在这里打开搜索时，搜索框改为原地按名字（或 pixiv ID）筛选名单（`filter`）。
 */
export function ArtistsView({
  safe,
  collecting,
  artist,
  filter = "",
  onArtist,
  onSettings,
}: {
  safe: boolean;
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
    <ArtistIndex filter={filter} onArtist={onArtist} onSettings={onSettings} />
  );
}

function ArtistIndex({
  filter,
  onArtist,
  onSettings,
}: {
  filter: string;
  onArtist: (artist: Artist) => void;
  onSettings?: (subscription: Subscription) => void;
}) {
  const { t, i18n } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const feedback = useFeedbackContext();
  const libraries = useLibraryOptions();
  const toast = useOptionalToast();
  /** ⋯ 里的“在 pixiv 上取消关注”：同时退订；做完给带“撤销”的轻提示，撤销就是重新关注（也就重新订阅）。 */
  const unfollow = async (a: Artist, subscription: Subscription) => {
    if (!feedback) return void subs?.unsubscribe(subscription, true);
    if (!(await feedback.setFollow(a, false))) return;
    toast?.show({
      title: t("browse.unfollowedArtist", { name: a.name }),
      action: { label: t("browse.undo"), onClick: () => void feedback.setFollow(a, true) },
    });
  };
  const artists = useMemo(() => {
    if (!subs?.list) return null;
    const seen = new Set<string>();
    const found: { artist: Artist; subscription: Subscription }[] = [];
    for (const s of subs.list) {
      if (s.target.kind !== "pixivArtist" || seen.has(s.target.userId)) continue;
      seen.add(s.target.userId);
      found.push({ artist: { userId: s.target.userId, name: s.name }, subscription: s });
    }
    return found;
  }, [subs?.list]);
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(i18n.language);
    return artists && [...artists].sort((a, b) => collator.compare(a.artist.name, b.artist.name));
  }, [artists, i18n.language]);

  if (subs?.failed) return <PixivStatus failed={subs.failed} retry={subs.retry} />;
  if (!sorted) return <PixivStatus loading />;
  if (!sorted.length) return <PixivStatus empty={t("browse.noArtists")} />;
  const word = filter.trim().toLocaleLowerCase();
  const shown = word
    ? sorted.filter(({ artist: a }) => a.name.toLocaleLowerCase().includes(word) || a.userId === word)
    : sorted;
  if (!shown.length) return <PixivStatus empty={t("browse.noMatchingArtists")} />;
  return (
    <ul
      className="pw-artists"
      aria-label={t("browse.artists")}
      style={{ "--pw-column": `${TARGET}px` } as React.CSSProperties}
    >
      {shown.map(({ artist: a, subscription }) => {
        const library = libraries.options.find((o) => o.value === subscription.libraryId)?.label;
        return (
          <li key={a.userId} className="pw-artist-cell">
            <button type="button" className="pw-artist" onClick={() => onArtist(a)}>
              <span className="pw-artist-name">{a.name}</span>
              <span className="k-description">{t("browse.artistId", { id: a.userId })}</span>
            </button>
            <Menu.Root>
              <Menu.Trigger
                className="k-icon-btn is-sm pw-artist-more"
                aria-label={t("browse.artistMore", { name: a.name })}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </Menu.Trigger>
              <MenuPopup label={t("browse.artistMore", { name: a.name })} align="end">
                <MenuLabel>{library ? t("browse.savesInto", { library }) : t("browse.savesIntoMissing")}</MenuLabel>
                {onSettings && (
                  <MenuItem icon={<SlidersHorizontal size={14} />} onClick={() => onSettings(subscription)}>
                    {t("browse.collectRange")}
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem
                  icon={<UserMinus size={14} />}
                  danger
                  disabled={!!feedback?.followPending(a.userId) || !!subs?.pending(subscription.id)}
                  onClick={() => void unfollow(a, subscription)}
                >
                  {t("browse.unfollowArtist")}
                </MenuItem>
              </MenuPopup>
            </Menu.Root>
          </li>
        );
      })}
    </ul>
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
  return (
    <>
      <div className="pw-subbar">
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
      </div>
      <FeedView
        feed={{ kind: "artist", userId: artist.userId, manga: kind === "manga" }}
        safe={safe}
        collecting={collecting}
      />
    </>
  );
}
