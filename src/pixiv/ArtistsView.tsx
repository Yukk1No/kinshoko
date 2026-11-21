import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import { errorText } from "../ipc";
import { subscriptions as listSubscriptions } from "../ipc/subscriptions";
import { Segmented } from "../ui/Segmented";
import { TARGET } from "../wall/wallShared";
import { FeedView } from "./FeedView";
import { FollowButton } from "./PixivWall";
import type { Collecting } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";

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
}: {
  safe: boolean;
  collecting: Collecting;
  /** 按名字筛选名单；空的不筛。 */
  filter?: string;
  /** 正在看的画师；为空时显示名单。 */
  artist: Artist | null;
  onArtist: (artist: Artist | null) => void;
}) {
  return artist ? (
    <ArtistWorks safe={safe} collecting={collecting} artist={artist} onBack={() => onArtist(null)} />
  ) : (
    <ArtistIndex filter={filter} onArtist={onArtist} />
  );
}

function ArtistIndex({ filter, onArtist }: { filter: string; onArtist: (artist: Artist) => void }) {
  const { t, i18n } = useTranslation("subscriptions");
  const [artists, setArtists] = useState<Artist[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies(attempt): attempt 是重读信号，effect 里不读它
  useEffect(() => {
    let alive = true;
    setFailed(null);
    listSubscriptions().then(
      (list) => {
        if (!alive) return;
        const seen = new Set<string>();
        const found: Artist[] = [];
        for (const s of list) {
          if (s.target.kind !== "pixivArtist" || seen.has(s.target.userId)) continue;
          seen.add(s.target.userId);
          found.push({ userId: s.target.userId, name: s.name });
        }
        setArtists(found);
      },
      (e: unknown) => alive && setFailed(e),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(i18n.language);
    return artists && [...artists].sort((a, b) => collator.compare(a.name, b.name));
  }, [artists, i18n.language]);

  if (failed)
    return (
      <div className="pw-status" role="status">
        <span>{t("browse.failed", { error: errorText(failed) })}</span>
        <button type="button" className="k-btn" onClick={() => setAttempt((n) => n + 1)}>
          {t("browse.retry")}
        </button>
      </div>
    );
  if (!sorted)
    return (
      <div className="pw-status" role="status">
        {t("browse.loading")}
      </div>
    );
  if (!sorted.length)
    return (
      <div className="pw-status" role="status">
        {t("browse.noArtists")}
      </div>
    );
  const word = filter.trim().toLocaleLowerCase();
  const shown = word ? sorted.filter((a) => a.name.toLocaleLowerCase().includes(word) || a.userId === word) : sorted;
  if (!shown.length)
    return (
      <div className="pw-status" role="status">
        {t("browse.noMatchingArtists")}
      </div>
    );
  return (
    <ul
      className="pw-artists"
      aria-label={t("browse.artists")}
      style={{ "--pw-column": `${TARGET}px` } as React.CSSProperties}
    >
      {shown.map((a) => (
        <li key={a.userId}>
          <button type="button" className="pw-artist" onClick={() => onArtist(a)}>
            <span className="pw-artist-name">{a.name}</span>
            <span className="k-description">{t("browse.artistId", { id: a.userId })}</span>
          </button>
        </li>
      ))}
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
          <FollowButton followed={following} onToggle={() => void feedback.setFollow(artist, !following)} />
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
