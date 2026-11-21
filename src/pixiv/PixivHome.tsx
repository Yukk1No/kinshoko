import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Feed } from "../bindings/Feed";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import { Segmented } from "../ui/Segmented";
import { ArtistsView } from "./ArtistsView";
import { FeedView } from "./FeedView";
import type { PixivWallHandle, WallSection } from "./PixivWall";
import { usePixivFeed } from "./usePixivFeed";
import { WallView } from "./WallView";
import "./pixiv.css";

const FOLLOWING: Feed = { kind: "following" };
const RECOMMENDED: Feed = { kind: "recommended" };
/**
 * 新作读几页：关注的新作是一条很长的流，这一段只放最近的一页，看完往下就是推荐。
 * “精选新作”怎么挑还没定（#461），定了以后换掉这一条。
 */
const FOLLOWING_PAGES = 1;

/** 标题行正中的五个去处（#461 2026-11-18）。新作与推荐是同一面墙上的两段。 */
export type Place = "following" | "recommended" | "ranking" | "bookmarks" | "artists";
type Home = "following" | "recommended";
type Visibility = "public" | "private";

const isHome = (place: Place): place is Home => place === "following" || place === "recommended";

/**
 * 订阅页的主区（#461）：没有侧栏，墙占满，标题行正中是五个去处。新作往下滚到推荐时，选中的一块跟着走。
 * 榜单、我的收藏、画师各自换一面墙（第 4 步）；离开再回来时，新作与推荐那面墙还停在原处，不重读。
 * 还没挂到应用里：最后一个 PR 换掉现有订阅页时才露出来。搜索在第 5 步加。
 */
export function PixivHome({ safe }: { safe: boolean }) {
  const { t } = useTranslation("subscriptions");
  const [place, setPlace] = useState<Place>("following");
  const [period, setPeriod] = useState<RankingPeriod>("day");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [artist, setArtist] = useState<Artist | null>(null);
  const wall = useRef<PixivWallHandle>(null);

  const go = (next: Place) => {
    setPlace(next);
    if (isHome(next)) wall.current?.scrollToSection(next);
    // 再点一次“画师”回到名单。
    if (next === "artists" && place === "artists") setArtist(null);
  };
  const viewArtist = useCallback((a: Artist) => {
    setArtist(a);
    setPlace("artists");
  }, []);
  const onSection = useCallback((key: string) => setPlace((p) => (isHome(p) ? (key as Home) : p)), []);

  return (
    <div className="pw-page">
      <div className="pw-tabs">
        <Segmented<Place>
          label={t("browse.tabs")}
          value={place}
          onChange={go}
          options={[
            { value: "following", label: t("browse.following") },
            { value: "recommended", label: t("browse.recommended") },
            { value: "ranking", label: t("browse.ranking") },
            { value: "bookmarks", label: t("browse.bookmarks") },
            { value: "artists", label: t("browse.artists") },
          ]}
        />
      </div>
      {/* 新作与推荐一直挂着，换到别的去处时只是藏起来（不用 display: none，那样滚动位置会丢），回来时停在原处。 */}
      <div
        className="pw-view"
        data-away={isHome(place) ? undefined : ""}
        aria-hidden={!isHome(place) || undefined}
        inert={!isHome(place)}
      >
        <HomeWall safe={safe} onSection={onSection} onArtist={viewArtist} handle={wall} />
      </div>
      {place === "ranking" && (
        <div className="pw-view">
          <div className="pw-subbar">
            <Segmented<RankingPeriod>
              label={t("browse.rankingPeriod")}
              value={period}
              onChange={setPeriod}
              options={[
                { value: "day", label: t("browse.day") },
                { value: "week", label: t("browse.week") },
                { value: "month", label: t("browse.month") },
              ]}
            />
          </div>
          {/* 只读全年龄榜：R-18 榜不在这里（安全模式也不必再藏一次）。 */}
          <FeedView feed={{ kind: "ranking", period, explicit: false }} safe={safe} onArtist={viewArtist} />
        </div>
      )}
      {place === "bookmarks" && (
        <div className="pw-view">
          <div className="pw-subbar">
            <Segmented<Visibility>
              label={t("browse.bookmarksVisibility")}
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: "public", label: t("browse.public") },
                { value: "private", label: t("browse.private") },
              ]}
            />
          </div>
          <FeedView feed={{ kind: "bookmarks", private: visibility === "private" }} safe={safe} onArtist={viewArtist} />
        </div>
      )}
      {place === "artists" && (
        <div className="pw-view">
          <ArtistsView safe={safe} artist={artist} onArtist={setArtist} />
        </div>
      )}
    </div>
  );
}

/** 新作与推荐：先读关注新作的一页，读完接着读推荐；推荐里与新作重复的作品去掉。 */
function HomeWall({
  safe,
  onSection,
  onArtist,
  handle,
}: {
  safe: boolean;
  onSection: (key: string) => void;
  onArtist: (artist: Artist) => void;
  handle: React.Ref<PixivWallHandle>;
}) {
  const following = usePixivFeed(FOLLOWING, FOLLOWING_PAGES);
  // 新作读完（或读不了）再读推荐，免得两条流同时排队。
  const recommended = usePixivFeed(following.done || following.error ? RECOMMENDED : null);
  const sections = useMemo<WallSection[]>(() => {
    // 推荐里偶尔有新作里已经出现的作品，只留新作里那一份。
    const seen = new Set(following.works.map((w) => w.id));
    return [
      { key: "following", works: following.works },
      { key: "recommended", works: recommended.works.filter((w) => !seen.has(w.id)) },
    ];
  }, [following.works, recommended.works]);
  const { more } = recommended;
  const onNearEnd = useCallback(() => more(), [more]);

  const failed = following.error ?? recommended.error;
  const retry = following.error ? following.retry : recommended.retry;
  const loading = following.loading || recommended.loading;
  const empty = !loading && !failed && following.done && recommended.done && sections.every((s) => !s.works.length);
  return (
    <WallView
      sections={sections}
      safe={safe}
      status={{ loading, failed, retry, empty }}
      onSection={onSection}
      onNearEnd={onNearEnd}
      onArtist={onArtist}
      handle={handle}
    />
  );
}
