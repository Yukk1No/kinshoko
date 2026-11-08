import { useEffect, useMemo, useState } from "react";
import { Name } from "../ui/Name";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, CircleAlert, LoaderCircle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc";
import { subscriptionAdd, subscriptionFollowing } from "../ipc/subscriptions";
import { subscribedArtists } from "./ArtistDialog";
import { ArtistOptionFields, backlogOf, explicitChoice, initialChoices, useLibraryOptions, type ArtistChoices } from "./artistOptions";

type Follows = { kind: "loading" } | { kind: "loaded"; artists: Artist[] } | { kind: "failed"; message: string };

/**
 * 从 pixiv 关注导入（#369，草图 B）：一次性读出登录账号的关注，勾选要订阅的画师，用同一套设置订阅。
 * 订阅名单是 Kinshoko 自己的，之后 pixiv 上的关注变化不影响它（#366）。
 */
export function FollowingDialog({ status, list, onClose, onBack, onAdded }: {
  status: SubscriptionStatus; list: Subscription[];
  onClose: () => void; onBack: () => void; onAdded: (added: Subscription[]) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "following" });
  const { t: ta } = useTranslation("subscriptions", { keyPrefix: "artist" });
  const libraries = useLibraryOptions();
  const fallback = libraries.options[0]?.value ?? "";
  const [follows, setFollows] = useState<Follows>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<ArtistChoices>(() => initialChoices(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = { ...choices, libraryId: choices.libraryId || fallback };
  const showExplicit = explicitChoice(status);
  const subscribed = useMemo(() => subscribedArtists(list), [list]);

  useEffect(() => {
    let alive = true;
    subscriptionFollowing().then((artists) => alive && setFollows({ kind: "loaded", artists }),
      (e) => alive && setFollows({ kind: "failed", message: t("loadFailed", { error: errorText(e) }) }));
    return () => { alive = false; };
  }, [t]);

  const artists = follows.kind === "loaded" ? follows.artists : [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? artists.filter((a) => a.name.toLowerCase().includes(needle) || a.userId.includes(needle)) : artists;
  const chosenArtists = artists.filter((a) => picked.has(a.userId) && !subscribed.has(a.userId));
  const backlog = backlogOf(chosen);
  const toggle = (id: string) => setPicked((now) => {
    const next = new Set(now);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const subscribe = () => {
    if (chosenArtists.length === 0 || !backlog || !chosen.libraryId) return;
    setBusy(true); setError(null);
    subscriptionAdd(chosenArtists.map((artist) => ({
      target: { kind: "pixivArtist", userId: artist.userId }, name: artist.name, libraryId: chosen.libraryId,
      includeExplicit: showExplicit ? chosen.includeExplicit : true, includeManga: chosen.includeManga, backlog,
    }))).then((added) => { onAdded(added); onClose(); },
      (e) => { setError(ta("failed", { error: errorText(e) })); setBusy(false); });
  };

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-artist-dialog">
        <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
        <div className="k-field-row">
          <span className="k-input">
            <Search size={16} aria-hidden="true" />
            <input value={filter} placeholder={t("filter")} aria-label={t("filter")} disabled={follows.kind !== "loaded"} onChange={(e) => setFilter(e.target.value)} />
          </span>
          {follows.kind === "loaded" && <span className="subs-follow-count tabular">{t("selected", { count: chosenArtists.length, total: artists.length })}</span>}
        </div>
        <div className="subs-follow-list">
          {follows.kind === "loading" && <p className="subs-follow-note" role="status"><LoaderCircle className="subs-spin" size={14} aria-hidden="true" />{t("loading")}</p>}
          {follows.kind === "failed" && <p className="k-field-error subs-follow-note" role="alert"><CircleAlert size={14} aria-hidden="true" />{follows.message}</p>}
          {follows.kind === "loaded" && artists.length === 0 && <p className="subs-follow-note">{t("none")}</p>}
          {shown.length > 0 && <ul>
            {shown.map((artist) => {
              const done = subscribed.has(artist.userId);
              return <li key={artist.userId}>
                <label className={`subs-follow-row${done ? " is-done" : ""}`}>
                  <input type="checkbox" disabled={busy || done} checked={done || picked.has(artist.userId)} onChange={() => toggle(artist.userId)} />
                  <span className="subs-avatar is-sm" aria-hidden="true">{artist.name.slice(0, 1).toUpperCase()}</span>
                  <Name className="subs-follow-name">{artist.name}</Name>
                  {done && <span className="k-pill"><span className="k-label">{t("subscribed")}</span></span>}
                </label>
              </li>;
            })}
          </ul>}
        </div>
        <ArtistOptionFields value={chosen} onChange={setChoices} backlogAs="select" showExplicit={showExplicit} disabled={busy} />
        {error && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        <div className="k-dialog-foot">
          <button type="button" className="k-btn is-quiet" disabled={busy} onClick={onBack}><ChevronLeft size={16} aria-hidden="true" /><span className="k-label">{t("back")}</span></button>
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}><span className="k-label">{ta("cancel")}</span></button>
          <button type="button" className="k-btn is-primary" disabled={busy || chosenArtists.length === 0 || !backlog || !chosen.libraryId} onClick={subscribe}>
            <span className="k-label">{busy ? ta("subscribing") : t("subscribe", { count: chosenArtists.length })}</span>
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
