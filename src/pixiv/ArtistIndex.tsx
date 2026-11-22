import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  FolderInput,
  History,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionPreview } from "../bindings/SubscriptionPreview";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { thumbnailUrl } from "../ipc";
import { ArtistDialog } from "../subscriptions/ArtistDialog";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { FollowingDialog } from "../subscriptions/FollowingDialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuSubmenu } from "../ui/Menu";
import { Select } from "../ui/Select";
import { useOptionalToast } from "../ui/Toast";
import { TARGET } from "../wall/wallShared";
import { COVERS, useRemoteCovers } from "./artistCovers";
import { LibraryChoices, sharedLibrary, useLibraryChange } from "./LibraryMenu";
import { PixivStatus } from "./Status";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";

/** 卡片缩略图的档位（`thumbnailTier` 的一档）。 */
const COVER_PX = 256;
const DAY = 24 * 60 * 60 * 1000;
/** 筛选里的“多久没有新图”，按天。 */
const QUIET = ["0", "60", "90", "180"] as const;
type Quiet = (typeof QUIET)[number];
type Sort = "name" | "recent" | "most";
/** 图库筛选里“已取消订阅的”那一项的值（不会和图库 ID 撞）。 */
const GONE = "\u0000gone";

type Card = { artist: Artist; subscription: Subscription; preview: SubscriptionPreview | undefined; gone: boolean };

/**
 * “画师”页的名单（#461，维护者 2026-11-22 认可的订阅入口）：订阅了的画师一张卡片一位，带最近几个作品的缩略图，
 * 认不出名字也能认出画风。这里就是管理画师订阅的地方：⋯ 里改收进的库、收哪些作品、取消订阅；“选择”以后可以对筛出来
 * 的一批一起改库或取消订阅。这次取消的画师留在“已取消订阅的”里，可以重新订阅。
 *
 * 缩略图先用本机已收的图；还没收过的画师，卡片滚进来时再读 pixiv 上最新的几张。
 */
const lastNew = (c: Card) => c.preview?.lastReceivedAt ?? null;

export function ArtistIndex({
  safe,
  status,
  filter,
  onArtist,
  onSettings,
}: {
  safe: boolean;
  status: SubscriptionStatus | null;
  filter: string;
  onArtist: (artist: Artist) => void;
  onSettings?: (subscription: Subscription) => void;
}) {
  const { t, i18n } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const feedback = useFeedbackContext();
  const libraries = useLibraryOptions();
  const [library, setLibrary] = useState("");
  const [quiet, setQuiet] = useState<Quiet>("0");
  const [sort, setSort] = useState<Sort>("name");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "import" | null>(null);

  const list = subs?.list;
  const gone = subs?.gone;
  const previews = subs?.previews;
  const cards = useMemo<Card[] | null>(() => {
    if (!list) return null;
    const card = (s: Subscription, isGone: boolean): Card | null =>
      s.target.kind === "pixivArtist"
        ? {
            artist: { userId: s.target.userId, name: s.name },
            subscription: s,
            preview: previews?.get(s.id),
            gone: isGone,
          }
        : null;
    return [...list.map((s) => card(s, false)), ...(gone ?? []).map((s) => card(s, true))].filter(
      (c): c is Card => c !== null,
    );
  }, [list, gone, previews]);

  const shown = useMemo(() => {
    if (!cards) return null;
    const word = filter.trim().toLocaleLowerCase();
    const now = Date.now();
    const days = Number(quiet);
    const collator = new Intl.Collator(i18n.language);
    return (
      cards
        .filter((c) => (library === GONE ? c.gone : !c.gone && (!library || c.subscription.libraryId === library)))
        .filter((c) => !word || c.artist.name.toLocaleLowerCase().includes(word) || c.artist.userId === word)
        // 还没收过图的，从订阅那天算起。
        .filter((c) => !days || now - (lastNew(c) ?? c.subscription.createdAt) >= days * DAY)
        .sort((a, b) =>
          sort === "recent"
            ? (lastNew(b) ?? 0) - (lastNew(a) ?? 0)
            : sort === "most"
              ? (b.preview?.received ?? 0) - (a.preview?.received ?? 0)
              : collator.compare(a.artist.name, b.artist.name),
        )
    );
  }, [cards, filter, library, quiet, sort, i18n.language]);

  // 在“已取消订阅的”里把最后一位订回来了：回到全部图库，不留在一个已经没有的筛选上。
  const noneGone = !!cards && !cards.some((c) => c.gone);
  useEffect(() => {
    if (noneGone && library === GONE) setLibrary("");
  }, [noneGone, library]);

  // 搜索时，名字对得上的已取消订阅的画师另外列在下面，免得以为他不见了。
  const goneMatches = useMemo(() => {
    const word = filter.trim().toLocaleLowerCase();
    if (!word || library === GONE || !cards) return [];
    return cards.filter((c) => c.gone && c.artist.name.toLocaleLowerCase().includes(word));
  }, [cards, filter, library]);

  const chosen = () => (shown ?? []).filter((c) => picked.has(c.subscription.id)).map((c) => c.subscription);
  const bulk = useLibraryChange(chosen);
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
    anchor.current = null;
  };
  const pick = (id: string, range: boolean) => {
    const ids = (shown ?? []).filter((c) => !c.gone).map((c) => c.subscription.id);
    setSelecting(true);
    setPicked((before) => {
      const next = new Set(before);
      const on = !before.has(id);
      if (range && anchor.current && ids.includes(anchor.current)) {
        const [from, to] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((a, b) => a - b);
        for (const x of ids.slice(from, to + 1)) on ? next.add(x) : next.delete(x);
      } else if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    anchor.current = id;
  };

  if (!subs) return null;
  if (subs.failed) return <PixivStatus failed={subs.failed} retry={subs.retry} />;
  if (!cards || !shown) return <PixivStatus loading />;

  const count = (id: string) => cards.filter((c) => !c.gone && c.subscription.libraryId === id).length;
  const goneCount = cards.filter((c) => c.gone).length;
  const live = shown.filter((c) => !c.gone);
  const selected = chosen();
  // 有一位正在关注或取消关注时不能批量动它，否则关注写完会把刚退订的又订回来。
  const busy =
    subs.pending("library") || selected.some((s) => subs.pending(s.id) || feedback?.followPending(artistId(s)));

  return (
    <>
      <div className="pw-subbar pw-artist-tools">
        {library === GONE && (
          <button type="button" className="k-btn is-sm" onClick={() => setLibrary("")}>
            <ArrowLeft size={14} aria-hidden="true" />
            {t("browse.allArtists")}
          </button>
        )}
        {library !== GONE && (
          <>
            <Select
              fit
              label={t("browse.filterLibrary")}
              value={library}
              onChange={(value) => {
                setLibrary(value);
                stopSelecting();
              }}
              options={[
                { value: "", label: t("browse.allLibraries") },
                ...libraries.options.map((o) => ({
                  value: o.value,
                  label: t("browse.inLibrary", { library: o.label, count: count(o.value) }),
                })),
              ]}
            />
            <Select<Quiet>
              fit
              label={t("browse.filterQuiet")}
              value={quiet}
              onChange={setQuiet}
              options={QUIET.map((d) => ({
                value: d,
                label: d === "0" ? t("browse.anyUpdate") : t("browse.quietFor", { count: Number(d) / 30 }),
              }))}
            />
            <Select<Sort>
              fit
              label={t("browse.sortArtists")}
              value={sort}
              onChange={setSort}
              options={[
                { value: "name", label: t("browse.sortName") },
                { value: "recent", label: t("browse.sortRecent") },
                { value: "most", label: t("browse.sortMost") },
              ]}
            />
          </>
        )}
        <span className="k-description pw-artist-count">{t("browse.artistCount", { count: shown.length })}</span>
        <span className="pw-subbar-gap" />
        {goneCount > 0 && (
          <button
            type="button"
            className="k-btn is-sm"
            aria-pressed={library === GONE}
            onClick={() => {
              setLibrary(library === GONE ? "" : GONE);
              stopSelecting();
            }}
          >
            <History size={14} aria-hidden="true" />
            {t("browse.goneArtists", { count: goneCount })}
          </button>
        )}
        {library !== GONE &&
          (selecting ? (
            <>
              <button
                type="button"
                className="k-btn is-sm"
                disabled={!live.length}
                onClick={() => setPicked(new Set(live.map((c) => c.subscription.id)))}
              >
                {t("browse.selectAll", { count: live.length })}
              </button>
              <button type="button" className="k-btn is-sm" onClick={stopSelecting}>
                {t("browse.stopSelecting")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="k-btn is-sm" disabled={!live.length} onClick={() => setSelecting(true)}>
                {t("browse.select")}
              </button>
              <button type="button" className="k-btn is-sm" disabled={!status} onClick={() => setDialog("import")}>
                <UserPlus size={14} aria-hidden="true" />
                {t("browse.importFollowing")}
              </button>
              <button type="button" className="k-btn is-sm" disabled={!status} onClick={() => setDialog("add")}>
                <Plus size={14} aria-hidden="true" />
                {t("browse.addArtist")}
              </button>
            </>
          ))}
      </div>

      {shown.length ? (
        <ul
          className={`pw-artists${selecting ? " is-selecting" : ""}`}
          aria-label={t("browse.artists")}
          style={{ "--pw-column": `${TARGET}px` } as React.CSSProperties}
        >
          {shown.map((c) => (
            <ArtistCard
              key={c.subscription.id}
              card={c}
              safe={safe}
              selecting={selecting}
              picked={picked.has(c.subscription.id)}
              onPick={(range) => pick(c.subscription.id, range)}
              onOpen={() => onArtist(c.artist)}
              onSettings={onSettings}
            />
          ))}
        </ul>
      ) : !cards.some((c) => !c.gone) && library !== GONE ? (
        <PixivStatus empty={t("browse.noArtists")} />
      ) : filter.trim() ? (
        <PixivStatus empty={t("browse.noMatchingArtists")} />
      ) : (
        <div className="pw-filter-empty">
          <PixivStatus empty={t("browse.noFilteredArtists")} />
          <button
            type="button"
            className="k-btn is-sm"
            onClick={() => {
              setLibrary("");
              setQuiet("0");
            }}
          >
            {t("browse.showAllArtists")}
          </button>
        </div>
      )}
      {goneMatches.length > 0 && (
        <ul className="pw-gone-matches" aria-label={t("browse.goneMatches")}>
          {goneMatches.map((c) => (
            <li key={c.subscription.id}>
              <span>{t("browse.goneArtist", { name: c.artist.name })}</span>
              <ResubscribeButton subscription={c.subscription} />
            </li>
          ))}
        </ul>
      )}

      {selecting && selected.length > 0 && (
        <div className="pw-bulkbar" role="toolbar" aria-label={t("browse.selectedCount", { count: selected.length })}>
          <span className="pw-bulkbar-count">{t("browse.selectedCount", { count: selected.length })}</span>
          <Menu.Root>
            <Menu.Trigger className="k-btn is-sm is-primary" disabled={busy}>
              <FolderInput size={14} aria-hidden="true" />
              {t("browse.changeLibrary")}
            </Menu.Trigger>
            <MenuPopup side="top" label={t("browse.savesIntoMenu")}>
              <LibraryChoices current={sharedLibrary(selected)} onPick={bulk.pick} onCreate={bulk.create} />
            </MenuPopup>
          </Menu.Root>
          <button
            type="button"
            className="k-btn is-sm"
            disabled={busy}
            onClick={async () => {
              const targets = selected;
              stopSelecting();
              await subs.unsubscribeMany(targets);
            }}
          >
            {t("browse.unsubscribe")}
          </button>
          <button
            type="button"
            className="k-icon-btn is-sm"
            aria-label={t("browse.stopSelecting")}
            onClick={stopSelecting}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {bulk.dialog}
      {status && dialog === "add" && list && (
        <ArtistDialog
          status={status}
          list={list}
          onClose={() => setDialog(null)}
          onAdded={subs.added}
          onImport={() => setDialog("import")}
        />
      )}
      {status && dialog === "import" && list && (
        <FollowingDialog
          status={status}
          list={list}
          onClose={() => setDialog(null)}
          onBack={() => setDialog("add")}
          onAdded={subs.added}
        />
      )}
    </>
  );
}

function ResubscribeButton({ subscription }: { subscription: Subscription }) {
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

const artistId = (s: Subscription) => (s.target.kind === "pixivArtist" ? s.target.userId : "");

/** 一位画师的卡片：缩略图、名字、多久没有新图、收进哪个库、⋯。已取消订阅的变淡，换成“重新订阅”。 */
function ArtistCard({
  card,
  safe,
  selecting,
  picked,
  onPick,
  onOpen,
  onSettings,
}: {
  card: Card;
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
  const open = (event: React.MouseEvent) => (selecting && !gone ? onPick(event.shiftKey) : onOpen());
  const writing = !!subs?.pending(subscription.id) || !!feedback?.followPending(a.userId);

  return (
    <li className={`pw-artist-cell${picked ? " is-picked" : ""}${gone ? " is-gone" : ""}`}>
      <button
        type="button"
        className="pw-artist-cover"
        ref={remote.ref as React.Ref<HTMLButtonElement>}
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
        <span className="k-description">
          {gone ? t("browse.unsubscribedShort") : lastNewText(t, preview, subscription.createdAt)}
        </span>
      </div>
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
