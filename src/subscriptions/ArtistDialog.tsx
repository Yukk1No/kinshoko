import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc";
import { subscriptionAdd, subscriptionFindArtist, subscriptionSetOptions } from "../ipc/subscriptions";
import { ArtistOptionFields, backlogOf, explicitChoice, followingChoice, initialChoices, useLibraryOptions, type ArtistChoices } from "./artistOptions";
import { UnofficialMark } from "./UnofficialMark";

type Lookup =
  | { kind: "idle" }
  | { kind: "finding" }
  | { kind: "found"; artist: Artist }
  | { kind: "failed"; message: string };

/** 已订阅的画师 ID。 */
export function subscribedArtists(list: Subscription[]): Set<string> {
  return new Set(list.flatMap((s) => (s.target.kind === "pixivArtist" ? [s.target.userId] : [])));
}

/**
 * 订阅画师（#369，草图 A）：输入画师主页链接或 ID 查找，再选资料库、旧作收多少、漫画与 R-18。
 * 登录失效时也能添加（恢复登录后才查），但不出现 R-18 与从关注导入。
 */
export function ArtistDialog({ status, list, libraryId, onClose, onAdded, onImport }: {
  status: SubscriptionStatus; list: Subscription[];
  /** 默认收进的资料库（当前打开的）。 */
  libraryId: string | null;
  onClose: () => void; onAdded: (added: Subscription[]) => void; onImport: () => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "artist" });
  const libraries = useLibraryOptions();
  const fallback = libraries.options.find((o) => o.value === libraryId)?.value ?? libraries.options[0]?.value ?? "";
  const [input, setInput] = useState("");
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });
  /** 第几次查找；输入改了也加一，晚到的旧结果对不上就丢掉。 */
  const asked = useRef(0);
  const [choices, setChoices] = useState<ArtistChoices>(() => initialChoices(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = { ...choices, libraryId: choices.libraryId || fallback };
  const showExplicit = explicitChoice(status);
  const found = lookup.kind === "found" ? lookup.artist : null;
  const already = found !== null && subscribedArtists(list).has(found.userId);
  const backlog = backlogOf(chosen);

  const find = () => {
    if (!input.trim() || lookup.kind === "finding") return;
    const request = ++asked.current;
    setLookup({ kind: "finding" });
    subscriptionFindArtist(input).then((artist) => { if (request === asked.current) setLookup({ kind: "found", artist }); },
      (e) => { if (request === asked.current) setLookup({ kind: "failed", message: errorText(e) }); });
  };
  const subscribe = () => {
    if (!found || already || !backlog || !chosen.libraryId) return;
    setBusy(true); setError(null);
    subscriptionAdd([{
      target: { kind: "pixivArtist", userId: found.userId }, name: found.name, libraryId: chosen.libraryId,
      includeExplicit: showExplicit ? chosen.includeExplicit : true, includeManga: chosen.includeManga, backlog,
    }]).then((added) => { onAdded(added); onClose(); },
      (e) => { setError(t("failed", { error: errorText(e) })); setBusy(false); });
  };

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-artist-dialog">
        <div className="subs-first-run-head">
          <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
          <UnofficialMark />
        </div>
        <form className="subs-artist-find" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <label className="k-field">
            <span className="k-field-label">{t("input")}</span>
            <span className="k-field-row">
              <span className="k-input" aria-invalid={lookup.kind === "failed" ? true : undefined}>
                <input value={input} aria-label={t("input")} placeholder={t("placeholder")} disabled={busy} autoFocus spellCheck={false}
                  onChange={(e) => { asked.current++; setInput(e.target.value); setLookup({ kind: "idle" }); }} />
              </span>
              <button type="submit" className="k-btn" disabled={busy || !input.trim() || lookup.kind === "finding"}>
                {lookup.kind === "finding" && <LoaderCircle className="subs-spin" size={14} aria-hidden="true" />}
                <span className="k-label">{t(lookup.kind === "finding" ? "finding" : "find")}</span>
              </button>
            </span>
          </label>
          {lookup.kind === "failed" && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{lookup.message}</p>}
        </form>
        {found && <div className="subs-artist-found">
          <span className="subs-avatar" aria-hidden="true">{found.name.slice(0, 1).toUpperCase()}</span>
          <span className="subs-account-text">
            <span className="subs-account-name">{found.name}</span>
            <span className="subs-account-sub">{t("id", { id: found.userId })}</span>
          </span>
          {already && <span className="k-pill"><span className="k-label">{t("already")}</span></span>}
        </div>}
        <ArtistOptionFields value={chosen} onChange={setChoices} backlogAs="cards" showExplicit={showExplicit} disabled={busy} />
        {error && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        <div className="k-dialog-foot">
          {followingChoice(status) && <button type="button" className="k-btn is-quiet" disabled={busy} onClick={onImport}><span className="k-label">{t("importFollowing")}</span></button>}
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}><span className="k-label">{t("cancel")}</span></button>
          <button type="button" className="k-btn is-primary" disabled={busy || !found || already || !backlog || !chosen.libraryId} onClick={subscribe}>
            <span className="k-label">{t(busy ? "subscribing" : "subscribe")}</span>
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** 订阅设置（草图 C）：只改漫画与 R-18；资料库与旧作是订阅时定的。 */
export function ArtistSettingsDialog({ subscription, status, onClose, onSaved }: {
  subscription: Subscription; status: SubscriptionStatus;
  onClose: () => void; onSaved: (saved: Subscription) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "artist" });
  const [choices, setChoices] = useState<ArtistChoices>(() => ({
    ...initialChoices(subscription.libraryId), includeManga: subscription.includeManga, includeExplicit: subscription.includeExplicit,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 不能选 R-18（没登录或账号没开 R-18）时不出现这一行，原来的选择照旧。
  const showExplicit = explicitChoice(status);
  const save = () => {
    setBusy(true); setError(null);
    subscriptionSetOptions(subscription.id, showExplicit ? choices.includeExplicit : subscription.includeExplicit, choices.includeManga)
      .then((saved) => { onSaved(saved); onClose(); }, (e) => { setError(t("saveFailed", { error: errorText(e) })); setBusy(false); });
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-artist-dialog">
        <Dialog.Title className="k-dialog-title">{t("settingsTitle")}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{subscription.name}</Dialog.Description>
        <ArtistOptionFields value={choices} onChange={setChoices} backlogAs={null} showExplicit={showExplicit} disabled={busy} />
        {error && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        <div className="k-dialog-foot">
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}><span className="k-label">{t("cancel")}</span></button>
          <button type="button" className="k-btn is-primary" disabled={busy} onClick={save}><span className="k-label">{t("save")}</span></button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
