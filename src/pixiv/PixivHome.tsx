import { useCallback, useId, useMemo, useRef, useState } from "react";
import { errorText } from "../ipc";
import { subscriptionFindArtist } from "../ipc/subscriptions";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Feed } from "../bindings/Feed";
import type { RankingPeriod } from "../bindings/RankingPeriod";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { ArtistSettingsDialog } from "../subscriptions/ArtistDialog";
import { useSubscriptionStatus } from "../subscriptions/useSubscriptionStatus";
import { PageFrame, PageSubbar, PageSurface, PageTopbar } from "../ui/PageFrame";
import { Segmented } from "../ui/Segmented";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";
import { WinCtrls } from "../ui/WinCtrls";
import { ArtistsView } from "./ArtistsView";
import { LibraryChip } from "./LibraryMenu";
import { FeedView } from "./FeedView";
import type { PixivWallHandle, WallSection } from "./PixivWall";
import { usePixivFeed } from "./usePixivFeed";
import { type Collecting, useCollect } from "./useCollect";
import { FeedbackContext, useFeedback } from "./useFeedback";
import { RANKING_TOP, SubscriptionsContext, type Subscriptions, useSubscriptions } from "./useSubscriptions";
import { ArtistResults, SearchBox, type SearchKind } from "./Search";
import { CollectPrompts, WallView } from "./WallView";

const FOLLOWING: Feed = { kind: "following" };
const RECOMMENDED: Feed = { kind: "recommended" };
/**
 * 新作读几页：关注的新作是一条很长的流，这一段只放最近的一页，看完往下就是推荐。
 * “精选新作”怎么挑还没定（#461），定了以后换掉这一条。
 */
const FOLLOWING_PAGES = 1;

/**
 * 标题行正中的五个去处（#461 2026-11-18）。新作与推荐是同一面墙上的两段。订阅不另设“管理”页（维护者 2026-11-22）：
 * 画师页管画师，榜单页、我的收藏页顶上有开关，全貌在头像卡打开的设置 › 订阅。
 */
export type Place = "following" | "recommended" | "ranking" | "bookmarks" | "artists";
type Home = "following" | "recommended";
type Visibility = "public" | "private";

const isHome = (place: Place): place is Home => place === "following" || place === "recommended";

/**
 * 订阅页的主区（#461）：没有侧栏，墙占满，标题行正中是五个去处。新作往下滚到推荐时，选中的一块跟着走。
 * 榜单、我的收藏、画师各自换一面墙（第 4 步）；离开再回来时，新作与推荐那面墙还停在原处，不重读。
 * 搜索（第 5 步）收在标题行左端，展开时五个去处让开；按回车后墙换成结果，收回时回到原来的去处，结果不保留。
 */
type SharedHome = { safe: boolean; status: SubscriptionStatus | null; subs: Subscriptions };

/**
 * 生产里由 `SubscriptionsMain` 注入共享名单；独立渲染仍可只给 `safe`，这时按原样自己读。
 */
export function PixivHome(props: { safe: boolean } | SharedHome) {
  return "subs" in props ? <PixivHomeView {...props} /> : <StandalonePixivHome safe={props.safe} />;
}

function StandalonePixivHome({ safe }: { safe: boolean }) {
  const [status] = useSubscriptionStatus();
  const subs = useSubscriptions(safe, status ? `${status.checking}:${status.newCount}` : null);
  return <PixivHomeView safe={safe} status={status} subs={subs} />;
}

function PixivHomeView({ safe, status, subs }: SharedHome) {
  const { t } = useTranslation("subscriptions");
  const [place, setPlace] = useState<Place>("following");
  const [period, setPeriod] = useState<RankingPeriod>("day");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [artist, setArtist] = useState<Artist | null>(null);
  const wall = useRef<PixivWallHandle>(null);
  /** 新作与推荐那面墙上次停在哪一段。 */
  const homeAt = useRef<Home>("following");
  const feedback = useFeedback(subs);
  /** 画师页 ⋯ 里打开的“收取范围”。 */
  const [settings, setSettings] = useState<Subscription | null>(null);
  const collecting = useCollect(undefined, feedback);
  const [searching, setSearching] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<SearchKind>("works");
  /** 按回车后的查找；为空时墙是当前去处。 */
  const [results, setResults] = useState<{ word: string; kind: SearchKind } | null>(null);
  const [finding, setFinding] = useState<unknown>(null);
  /** 在“画师”页里打开的搜索是原地筛选名单。 */
  const filtering = place === "artists" && !results;

  /** 每次收起搜索或再按一次回车加一：之前发出的“按 ID 找画师”回来也不再用。 */
  const lookup = useRef(0);
  const closeSearch = useCallback(() => {
    lookup.current += 1;
    setSearching(false);
    setText("");
    setResults(null);
    setFinding(null);
  }, []);
  const submit = () => {
    const word = text.trim();
    const ask = ++lookup.current;
    setFinding(null);
    // 画师主页链接或数字 ID：直接打开这位画师。
    if (kind === "artists" && /^\d+$|pixiv\.net\//.test(word)) {
      subscriptionFindArtist(word).then(
        (found) => {
          if (ask !== lookup.current) return;
          closeSearch();
          setArtist(found);
          setPlace("artists");
        },
        (error: unknown) => {
          if (ask === lookup.current) setFinding(error);
        },
      );
      return;
    }
    setResults({ word, kind });
  };

  const go = (next: Place) => {
    setPlace(next);
    if (!isHome(next)) return;
    // 从别的去处回到上次停的那一段：墙原样停着，不滚。换到另一段才滚过去。
    if (isHome(place) || next !== homeAt.current) wall.current?.scrollToSection(next);
    homeAt.current = next;
  };
  const home = isHome(place) && !results;
  const viewArtist = useCallback(
    (a: Artist) => {
      closeSearch();
      setArtist(a);
      setPlace("artists");
    },
    [closeSearch],
  );
  const onSection = useCallback((key: string) => {
    homeAt.current = key as Home;
    setPlace((p) => (isHome(p) ? (key as Home) : p));
  }, []);

  return (
    <SubscriptionsContext value={subs}>
      <FeedbackContext value={feedback}>
        <PageFrame className="pw-page">
          {/* 标题行就是主窗口顶栏：空白处拖动窗口，右端是窗口按钮。 */}
          <PageTopbar className="pw-tabs">
            <SearchBox
              open={searching}
              text={text}
              kind={kind}
              filtering={filtering}
              onOpen={() => setSearching(true)}
              onText={(next) => {
                setText(next);
                // 在“画师”页里一打字就回到名单筛选。
                if (filtering && next.trim()) setArtist(null);
              }}
              onKind={setKind}
              onSubmit={submit}
              onClose={closeSearch}
            />
            {/* 标题行一次只放一样东西：搜索展开时五个去处让开。 */}
            {!searching && (
              <Segmented<Place>
                className="pw-places"
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
            )}
            <div className="pw-tabs-end" data-tauri-drag-region>
              <WinCtrls />
            </div>
          </PageTopbar>
          {finding != null && (
            <div className="pw-status" role="alert">
              <span className="k-error-text">{t("browse.failed", { error: errorText(finding) })}</span>
            </div>
          )}
          {/* 新作与推荐一直挂着，换到别的去处时只是藏起来（不用 display: none，那样滚动位置会丢），回来时停在原处。 */}
          <PageSurface
            className="pw-view"
            data-away={home ? undefined : ""}
            aria-hidden={!home || undefined}
            inert={!home}
          >
            <HomeWall safe={safe} collecting={collecting} onSection={onSection} onArtist={viewArtist} handle={wall} />
          </PageSurface>
          {results && (
            <PageSurface className="pw-view">
              {results.kind === "works" ? (
                <FeedView
                  feed={{ kind: "search", word: results.word }}
                  safe={safe}
                  collecting={collecting}
                  onArtist={viewArtist}
                />
              ) : (
                <ArtistResults key={results.word} word={results.word} onArtist={viewArtist} />
              )}
            </PageSurface>
          )}
          {!results && place === "ranking" && (
            <PageSurface className="pw-view">
              <PageSubbar className="pw-subbar">
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
                <RankingSwitch subs={subs} period={period} />
              </PageSubbar>
              {/* 只读全年龄榜：R-18 榜不在这里（安全模式也不必再藏一次）。 */}
              <FeedView
                feed={{ kind: "ranking", period, explicit: false }}
                safe={safe}
                collecting={collecting}
                onArtist={viewArtist}
              />
            </PageSurface>
          )}
          {!results && place === "bookmarks" && (
            <PageSurface className="pw-view">
              <PageSubbar className="pw-subbar">
                <Segmented<Visibility>
                  label={t("browse.bookmarksVisibility")}
                  value={visibility}
                  onChange={setVisibility}
                  options={[
                    { value: "public", label: t("browse.public") },
                    { value: "private", label: t("browse.private") },
                  ]}
                />
                <SubbarSwitch
                  label={t("browse.syncBookmarks")}
                  hint={t("browse.syncBookmarksHint")}
                  checked={!!subs.bookmarks()}
                  disabled={!subs.ready || subs.pending(subs.bookmarks()?.id ?? "bookmarks")}
                  onChange={(on) => void subs.setBookmarks(on)}
                  subscription={subs.bookmarks()}
                />
              </PageSubbar>
              <FeedView
                feed={{ kind: "bookmarks", private: visibility === "private" }}
                safe={safe}
                collecting={collecting}
                onArtist={viewArtist}
              />
            </PageSurface>
          )}
          {!results && place === "artists" && (
            <PageSurface className="pw-view">
              <ArtistsView
                safe={safe}
                collecting={collecting}
                status={status}
                artist={artist}
                filter={searching ? text : ""}
                onArtist={setArtist}
                onSettings={setSettings}
              />
            </PageSurface>
          )}
          <CollectPrompts collecting={collecting} />
          {subs.notice && (
            <div className="pw-status" role="alert">
              <span className="k-error-text">{subs.notice}</span>
            </div>
          )}
          {status && settings && (
            <ArtistSettingsDialog
              subscription={settings}
              status={status}
              onClose={() => setSettings(null)}
              onSaved={subs.saved}
            />
          )}
        </PageFrame>
      </FeedbackContext>
    </SubscriptionsContext>
  );
}

/** 新作与推荐：先读关注新作的一页，读完接着读推荐；推荐里与新作重复的作品去掉。 */
function HomeWall({
  safe,
  collecting,
  onSection,
  onArtist,
  handle,
}: {
  safe: boolean;
  collecting: Collecting;
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
      collecting={collecting}
      status={{ loading, failed, retry, empty }}
      onSection={onSection}
      onNearEnd={onNearEnd}
      onArtist={onArtist}
      handle={handle}
    />
  );
}

/** 榜单页顶上的“自动收日榜 / 周榜 / 月榜”（#461 第 6 步），跟着选中的周期换。 */
function RankingSwitch({ subs, period }: { subs: Subscriptions; period: RankingPeriod }) {
  const { t } = useTranslation("subscriptions");
  const sub = subs.ranking(period);
  return (
    <SubbarSwitch
      label={t("browse.autoRanking", { ranking: t(`browse.${period}`) })}
      hint={t("browse.autoRankingHint", { count: sub?.target.kind === "pixivRanking" ? sub.target.top : RANKING_TOP })}
      checked={!!sub}
      disabled={!subs.ready || subs.pending(sub?.id ?? `ranking:${period}`)}
      onChange={(on) => void subs.setRanking(period, on)}
      subscription={sub}
    />
  );
}

/** 第二行右端的就地订阅开关：点文字也能拨。开着时旁边是“收进「某库」”，点开能换库；关着时补充说明在悬停提示里。 */
function SubbarSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
  subscription,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  subscription: Subscription | undefined;
}) {
  const id = useId();
  // 关着时收多少、从哪天收起只在悬停提示里说（interface-text-rules：不写解释性描述）。开着时不弹。
  // 一直包着 Tip：拨开关时不换掉这一行，焦点留在开关上。
  return (
    <Tip label={subscription ? null : hint} align="end">
      <div className="pw-subbar-switch">
        <Switch id={id} checked={checked} disabled={disabled} label={label} onCheckedChange={onChange} />
        <label htmlFor={id}>{label}</label>
        {subscription && <LibraryChip subscription={subscription} />}
      </div>
    </Tip>
  );
}
