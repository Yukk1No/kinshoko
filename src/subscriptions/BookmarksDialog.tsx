import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc";
import { subscriptionAdd } from "../ipc/subscriptions";
import { BacklogCards, backlogOf, explicitChoice, initialChoices, KindSwitches, LibraryField, RECENT_DEFAULT, useLibraryOptions, type ArtistChoices, type BacklogLabels } from "./artistOptions";
import { UnofficialMark } from "./UnofficialMark";

/** 已经在同步收藏夹（一个账号只有一个收藏夹）。 */
export function syncingBookmarks(list: Subscription[]): boolean {
  return list.some((s) => s.target.kind === "pixivBookmarks");
}

type FeedChoice = Pick<ArtistChoices, "backlog" | "recentCount">;

/**
 * 同步 pixiv 收藏夹（#371）：单向，pixiv 上新收藏的作品存进来，取消收藏不删图；公开与非公开收藏都同步。
 * 首次开启时选图库、已有的公开与非公开收藏各同步多少（pixiv 不给收藏时间，两边没法合起来数，由画师分别选）、
 * 漫画与 R-18；R-18 一行只在登录着、账号开着 R-18 时出现。
 */
export function BookmarksDialog({ status, libraryId, onClose, onAdded }: {
  status: SubscriptionStatus;
  /** 默认存进的资料库（当前打开的）。 */
  libraryId: string | null;
  onClose: () => void; onAdded: (added: Subscription[]) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "bookmarks" });
  const libraries = useLibraryOptions();
  const fallback = libraries.options.find((o) => o.value === libraryId)?.value ?? libraries.options[0]?.value ?? "";
  const [chosenLibrary, setLibrary] = useState("");
  const [feeds, setFeeds] = useState<{ public: FeedChoice; private: FeedChoice }>(() => ({
    public: { backlog: "newOnly", recentCount: String(RECENT_DEFAULT) },
    private: { backlog: "newOnly", recentCount: String(RECENT_DEFAULT) },
  }));
  const [kinds, setKinds] = useState(() => {
    const { includeManga, includeExplicit } = initialChoices("");
    return { includeManga, includeExplicit };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const library = chosenLibrary || fallback;
  const showExplicit = explicitChoice(status);
  const publicBacklog = backlogOf({ ...initialChoices(""), ...feeds.public });
  const privateBacklog = backlogOf({ ...initialChoices(""), ...feeds.private });
  const labels: BacklogLabels = { newOnly: t("newOnly"), recent: t("recent"), recentUnit: t("recentUnit"), recentLabel: t("recentLabel"), all: t("all") };

  const subscribe = () => {
    if (!publicBacklog || !privateBacklog || !library) return;
    setBusy(true); setError(null);
    subscriptionAdd([{
      target: { kind: "pixivBookmarks" }, name: "", libraryId: library,
      includeExplicit: showExplicit ? kinds.includeExplicit : true, includeManga: kinds.includeManga,
      backlog: publicBacklog, privateBacklog,
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
        <LibraryField label={t("library")} value={library} onChange={setLibrary} disabled={busy} />
        <BacklogCards name="bookmarks-public" label={t("public")} labels={labels} inline disabled={busy}
          value={feeds.public} onChange={(v) => setFeeds((f) => ({ ...f, public: v }))} />
        <BacklogCards name="bookmarks-private" label={t("private")} labels={{ ...labels, recentLabel: t("privateRecentLabel") }} inline disabled={busy}
          value={feeds.private} onChange={(v) => setFeeds((f) => ({ ...f, private: v }))} />
        <KindSwitches value={kinds} onChange={(patch) => setKinds((k) => ({ ...k, ...patch }))} showExplicit={showExplicit} disabled={busy} />
        {error && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        <div className="k-dialog-foot">
          <span className="k-grow" />
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}><span className="k-label">{t("cancel")}</span></button>
          <button type="button" className="k-btn is-primary" disabled={busy || !publicBacklog || !privateBacklog || !library} onClick={subscribe}>
            <span className="k-label">{t(busy ? "subscribing" : "subscribe")}</span>
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
