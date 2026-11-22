import { useMemo, useState } from "react";
import { Plus, SlidersHorizontal, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { ArtistDialog, ArtistSettingsDialog } from "../subscriptions/ArtistDialog";
import { useLibraryOptions } from "../subscriptions/artistOptions";
import { FollowingDialog } from "../subscriptions/FollowingDialog";
import { displayName } from "../subscriptions/rankingNames";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";
import { PixivStatus } from "./Status";
import { RANKING_TOP, useSubscriptionsContext } from "./useSubscriptions";

type Dialog = { kind: "add" } | { kind: "import" } | { kind: "settings"; subscription: Subscription };

const PERIODS = ["day", "week", "month"] as const;

/**
 * “管理”（#461 第 6 步）：同一份订阅名单的总表。画师（收进哪个资料库、收取范围、取消订阅）、榜单与 pixiv 收藏夹
 * 的开关，以及“订阅画师”“从关注导入”。和画师页、榜单页、我的收藏页的就地开关改的是同一份，改了立刻互相跟着变。
 *
 * 这里的“取消订阅”只退订，不在 pixiv 上取消关注：pixiv 上的写入只由画师在“关注”按钮上亲手点（#409）。
 */
export function ManageView({ status }: { status: SubscriptionStatus | null }) {
  const { t, i18n } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const libraries = useLibraryOptions();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const list = subs?.list;
  const artists = useMemo(() => {
    const collator = new Intl.Collator(i18n.language);
    return (list ?? []).filter((s) => s.target.kind === "pixivArtist").sort((a, b) => collator.compare(a.name, b.name));
  }, [list, i18n.language]);

  if (!subs) return null;
  if (subs.failed) return <PixivStatus failed={subs.failed} retry={subs.retry} />;
  if (!list) return <PixivStatus loading />;

  const library = (s: Subscription) =>
    t("browse.rowMeta", {
      library: libraries.options.find((o) => o.value === s.libraryId)?.label ?? "—",
    });
  // R-18 榜不在榜单页里，只有已经订阅了的才在这里列出来，用来退订。
  const explicitRankings = list.filter((s) => s.target.kind === "pixivRanking" && s.target.explicit);
  const bookmarks = subs.bookmarks();

  return (
    <div className="pw-manage">
      <section className="pw-manage-section" aria-labelledby="pw-manage-artists">
        <div className="pw-manage-head">
          <h2 id="pw-manage-artists" className="k-section-label">
            {t("browse.manageArtists", { count: artists.length })}
          </h2>
          <button
            type="button"
            className="k-btn is-sm"
            disabled={!status}
            onClick={() => setDialog({ kind: "import" })}
          >
            <UserPlus size={14} aria-hidden="true" />
            {t("browse.importFollowing")}
          </button>
          <button type="button" className="k-btn is-sm" disabled={!status} onClick={() => setDialog({ kind: "add" })}>
            <Plus size={14} aria-hidden="true" />
            {t("browse.addArtist")}
          </button>
        </div>
        <ul className="pw-rows" aria-label={t("browse.artists")}>
          {artists.length === 0 && <li className="pw-row k-description">{t("browse.noSubscribedArtists")}</li>}
          {artists.map((s) => (
            <li key={s.id} className="pw-row">
              <span className="pw-row-name">{s.name}</span>
              <span className="k-description">{library(s)}</span>
              <button
                type="button"
                className="k-icon-btn is-sm"
                aria-label={t("browse.rangeOf", { name: s.name })}
                disabled={!status}
                onClick={() => setDialog({ kind: "settings", subscription: s })}
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
              </button>
              <Tip label={t("browse.unsubscribeNote")}>
                <button
                  type="button"
                  className="k-btn is-sm is-quiet"
                  aria-label={t("browse.unsubscribeNamed", { name: s.name })}
                  disabled={subs.pending(s.id)}
                  onClick={() => void subs.unsubscribe(s, true)}
                >
                  {t("browse.unsubscribe")}
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      </section>

      <section className="pw-manage-section" aria-labelledby="pw-manage-rankings">
        <div className="pw-manage-head">
          <h2 id="pw-manage-rankings" className="k-section-label">
            {t("browse.manageRankings")}
          </h2>
        </div>
        <ul className="pw-rows">
          {PERIODS.map((period) => {
            const sub = subs.ranking(period);
            const name = t(`browse.${period}`);
            return (
              <li key={period} className="pw-row">
                <span className="pw-row-name">{name}</span>
                <span className="k-description">
                  {sub ? library(sub) : t("browse.autoRankingHint", { count: RANKING_TOP })}
                </span>
                <Switch
                  label={t("browse.autoRanking", { ranking: name })}
                  checked={!!sub}
                  disabled={subs.pending(sub?.id ?? `ranking:${period}`)}
                  onCheckedChange={(on) => void subs.setRanking(period, on)}
                />
              </li>
            );
          })}
          {explicitRankings.map((s) => (
            <li key={s.id} className="pw-row">
              <span className="pw-row-name">{displayName(t, s)}</span>
              <span className="k-description">{library(s)}</span>
              <Switch
                label={displayName(t, s)}
                checked
                disabled={subs.pending(s.id)}
                onCheckedChange={() => void subs.unsubscribe(s)}
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="pw-manage-section" aria-labelledby="pw-manage-bookmarks">
        <div className="pw-manage-head">
          <h2 id="pw-manage-bookmarks" className="k-section-label">
            {t("browse.manageBookmarks")}
          </h2>
        </div>
        <ul className="pw-rows">
          <li className="pw-row">
            <span className="pw-row-name">{t("browse.bookmarksBoth")}</span>
            <span className="k-description">{bookmarks ? library(bookmarks) : t("browse.bookmarksRowHint")}</span>
            <Switch
              label={t("browse.syncBookmarks")}
              checked={!!bookmarks}
              disabled={subs.pending(bookmarks?.id ?? "bookmarks")}
              onCheckedChange={(on) => void subs.setBookmarks(on)}
            />
          </li>
        </ul>
      </section>

      <p className="k-description pw-manage-foot">{t("browse.accountHint")}</p>

      {status && dialog?.kind === "add" && (
        <ArtistDialog
          status={status}
          list={list}
          onClose={() => setDialog(null)}
          onAdded={subs.added}
          onImport={() => setDialog({ kind: "import" })}
        />
      )}
      {status && dialog?.kind === "import" && (
        <FollowingDialog
          status={status}
          list={list}
          onClose={() => setDialog(null)}
          onBack={() => setDialog({ kind: "add" })}
          onAdded={subs.added}
        />
      )}
      {status && dialog?.kind === "settings" && (
        <ArtistSettingsDialog
          subscription={dialog.subscription}
          status={status}
          onClose={() => setDialog(null)}
          onSaved={subs.saved}
        />
      )}
    </div>
  );
}
