import { useEffect, useMemo, useState } from "react";
import { SelectableList } from "../ui/SelectableList";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronLeft, CircleAlert, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc";
import { subscriptionAdd, subscriptionFollowing } from "../ipc/subscriptions";
import { subscribedArtists } from "./ArtistDialog";
import {
  ArtistOptionFields,
  backlogOf,
  explicitChoice,
  initialChoices,
  useLibraryOptions,
  type ArtistChoices,
} from "./artistOptions";

type Follows = { kind: "loading" } | { kind: "loaded"; artists: Artist[] } | { kind: "failed"; message: string };

/**
 * 从 pixiv 关注导入（#369，草图 B）：一次性读出登录账号的关注，勾选要订阅的画师，用同一套设置订阅。
 * 订阅名单是 Kinshoko 自己的，之后 pixiv 上的关注变化不影响它（#366）。
 */
export function FollowingDialog({
  status,
  list,
  onClose,
  onBack,
  onAdded,
}: {
  status: SubscriptionStatus;
  list: Subscription[];
  onClose: () => void;
  onBack: () => void;
  onAdded: (added: Subscription[]) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "following" });
  const { t: ta } = useTranslation("subscriptions", { keyPrefix: "artist" });
  const libraries = useLibraryOptions();
  const fallback = libraries.options[0]?.value ?? "";
  const [follows, setFollows] = useState<Follows>({ kind: "loading" });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<ArtistChoices>(() => initialChoices(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = { ...choices, libraryId: choices.libraryId || fallback };
  const showExplicit = explicitChoice(status);
  const subscribed = useMemo(() => subscribedArtists(list), [list]);

  useEffect(() => {
    let alive = true;
    subscriptionFollowing().then(
      (artists) => alive && setFollows({ kind: "loaded", artists }),
      (e) => alive && setFollows({ kind: "failed", message: t("loadFailed", { error: errorText(e) }) }),
    );
    return () => {
      alive = false;
    };
  }, [t]);

  const artists = follows.kind === "loaded" ? follows.artists : [];
  const chosenArtists = artists.filter((a) => picked.has(a.userId) && !subscribed.has(a.userId));
  const backlog = backlogOf(chosen);
  const subscribe = () => {
    if (chosenArtists.length === 0 || !backlog || !chosen.libraryId) return;
    setBusy(true);
    setError(null);
    subscriptionAdd(
      chosenArtists.map((artist) => ({
        target: { kind: "pixivArtist", userId: artist.userId },
        name: artist.name,
        libraryId: chosen.libraryId,
        includeExplicit: showExplicit ? chosen.includeExplicit : true,
        includeManga: chosen.includeManga,
        backlog,
      })),
    ).then(
      (added) => {
        onAdded(added);
        onClose();
      },
      (e) => {
        setError(ta("failed", { error: errorText(e) }));
        setBusy(false);
      },
    );
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog subs-artist-dialog subs-following-dialog">
          <Dialog.Title className="k-title">{t("title")}</Dialog.Title>
          <SelectableList
            label={t("title")}
            filterLabel={t("filter")}
            selected={picked}
            onChange={setPicked}
            disabled={busy || follows.kind !== "loaded"}
            items={artists.map((artist) => ({
              id: artist.userId,
              name: artist.name,
              done: subscribed.has(artist.userId),
              leading: artist.name.slice(0, 1).toUpperCase(),
              trailing: subscribed.has(artist.userId) ? (
                <span className="k-pill">
                  <span className="k-label">{t("subscribed")}</span>
                </span>
              ) : undefined,
            }))}
            status={
              follows.kind === "loading" ? (
                <p className="k-description is-body k-choice-status" role="status">
                  <LoaderCircle className="k-spinner" size={14} aria-hidden="true" />
                  {t("loading")}
                </p>
              ) : follows.kind === "failed" ? (
                <p className="k-error-text is-field" role="alert">
                  <CircleAlert size={14} aria-hidden="true" />
                  {follows.message}
                </p>
              ) : artists.length === 0 ? (
                <p className="k-description is-body k-choice-status">{t("none")}</p>
              ) : undefined
            }
          />
          <ArtistOptionFields
            value={chosen}
            onChange={setChoices}
            backlogAs="select"
            showExplicit={showExplicit}
            disabled={busy}
          />
          {error && (
            <p className="k-error-text is-field" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              {error}
            </p>
          )}
          <div className="k-dialog-foot">
            <button type="button" className="k-btn is-quiet" disabled={busy} onClick={onBack}>
              <ChevronLeft size={16} aria-hidden="true" />
              <span className="k-label">{t("back")}</span>
            </button>
            <span className="k-grow" />
            <span className="k-description" aria-live="polite">
              {t("selected", { count: chosenArtists.length, total: artists.length })}
            </span>
            <button type="button" className="k-btn" disabled={busy} onClick={onClose}>
              <span className="k-label">{ta("cancel")}</span>
            </button>
            <button
              type="button"
              className="k-btn is-primary"
              disabled={busy || chosenArtists.length === 0 || !backlog || !chosen.libraryId}
              onClick={subscribe}
            >
              <span className="k-label">
                {busy ? ta("subscribing") : t("subscribe", { count: chosenArtists.length })}
              </span>
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
