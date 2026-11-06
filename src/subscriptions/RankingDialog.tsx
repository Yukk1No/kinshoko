import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { createLibraryUnopened, errorText } from "../ipc";
import { subscriptionAdd, subscriptionSetOptions } from "../ipc/subscriptions";
import { NewLibraryFields } from "../library/CreateLibrary";
import { useSaveDestination } from "../library/SaveDestination";
import { newLibraryParentPrefill } from "../library/savePrefill";
import { Segmented } from "../ui/Segmented";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { explicitChoice, LibrarySelect, useLibraryOptions } from "./artistOptions";
import { displayName, RANKINGS, rankingKey, rankingName, TOPS, type Ranking, type RankingKey, type Top } from "./rankingNames";
import { UnofficialMark } from "./UnofficialMark";

/** 名次分段：前 10／50／100。 */
function TopPicker({ label, value, onChange }: { label: string; value: Top; onChange: (top: Top) => void }) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "ranking" });
  return <Segmented className="subs-rank-seg" label={label} value={String(value) as `${Top}`}
    onChange={(v) => onChange(Number(v) as Top)}
    options={TOPS.map((top) => ({ value: String(top) as `${Top}`, label: t("top", { count: top }) }))} />;
}

type Library = { mode: "new" | "existing"; existingId: string; name: string; parent: string | null };

/**
 * 订阅榜单（#370，原型「榜单 #370」R1–R4）：日榜、周榜、月榜各一行，勾上几行订几个，每行选名次。
 * 「R-18 作品」开着时多出 R-18 日榜与周榜（pixiv 没有 R-18 月榜）；它只在登录着、账号开着 R-18 时出现（安全模式只藏图，
 * 不藏这些选项）。第一次订榜单时默认新建单独的图库「pixiv 榜单」，位置按 ADR-0016 预填、建好后不切换过去；已有榜单订阅时默认
 * 放进同一个图库，选了别的图库时提示可能重复收（去重只在同一个图库里）。说明性的文字不放在界面上（维护者 2026-11-02）。
 */
export function RankingDialog({ status, list, onClose, onAdded }: {
  status: SubscriptionStatus; list: Subscription[];
  onClose: () => void; onAdded: (added: Subscription[]) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "ranking" });
  const { t: ts } = useTranslation("subscriptions");
  const libraries = useLibraryOptions();
  const { providers, memory, rememberNewLibraryParent } = useSaveDestination();
  const rankings = list.filter((s) => s.target.kind === "pixivRanking");
  const subscribed = new Map<RankingKey, number>(rankings.flatMap((s) =>
    s.target.kind === "pixivRanking" ? [[rankingKey(s.target.period, s.target.explicit), s.target.top] as const] : []));
  const rankingLibraries = new Set(rankings.map((s) => s.libraryId));
  const showExplicit = explicitChoice(status);
  const [explicitOn, setExplicitOn] = useState(true);
  const firstOpen = RANKINGS.find((r) => !r.explicit && !subscribed.has(r.key))?.key;
  const [picks, setPicks] = useState<Partial<Record<RankingKey, boolean>>>(() => (firstOpen ? { [firstOpen]: true } : {}));
  const [tops, setTops] = useState<Record<RankingKey, Top>>({ day: 50, week: 50, month: 50, dayExplicit: 10, weekExplicit: 10 });
  const [manga, setManga] = useState(false);
  const [library, setLibrary] = useState<Partial<Library>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultName = t("defaultLibraryName");
  const named = libraries.options.find((o) => o.label === defaultName)?.value;
  const latestRanking = [...rankings].reverse().find((s) => libraries.options.some((o) => o.value === s.libraryId))?.libraryId;
  const chosen: Library = {
    mode: library.mode ?? (rankings.length > 0 || named ? "existing" : "new"),
    existingId: library.existingId ?? latestRanking ?? named ?? libraries.options[0]?.value ?? "",
    name: library.name ?? defaultName,
    parent: library.parent !== undefined ? library.parent : newLibraryParentPrefill(rankings.map((s) => s.libraryId), memory.newLibraryParent, providers),
  };
  const set = (patch: Partial<Library>) => setLibrary((l) => ({ ...l, ...patch }));

  const shown = RANKINGS.filter((r) => !r.explicit || (showExplicit && explicitOn));
  const picked = shown.filter((r) => !subscribed.has(r.key) && picks[r.key]);
  const open = shown.filter((r) => !subscribed.has(r.key)).length;
  const libraryReady = chosen.mode === "new" ? chosen.name.trim() !== "" && chosen.parent !== null : chosen.existingId !== "";
  const otherLibrary = rankings.length > 0 && chosen.mode === "existing" && !rankingLibraries.has(chosen.existingId);

  const subscribe = async () => {
    if (picked.length === 0 || !libraryReady) return;
    setBusy(true); setError(null);
    let target = chosen.existingId;
    if (chosen.mode === "new") {
      try {
        target = (await createLibraryUnopened(chosen.parent!, chosen.name.trim())).id;
        if (library.parent) rememberNewLibraryParent(library.parent);
        // 建好了：订阅没成也不再建第二次，下次直接放进它。
        set({ mode: "existing", existingId: target });
      } catch (e) {
        setError(t("libraryFailed", { error: errorText(e) })); setBusy(false);
        return;
      }
    }
    try {
      onAdded(await subscriptionAdd(picked.map((r) => ({
        target: { kind: "pixivRanking", period: r.period, top: tops[r.key], explicit: r.explicit },
        name: rankingName(ts, r.period, r.explicit, tops[r.key]), libraryId: target,
        includeExplicit: true, includeManga: manga, backlog: { kind: "all" },
      }))));
      onClose();
    } catch (e) {
      setError(t("failed", { error: errorText(e) })); setBusy(false);
    }
  };

  const row = (r: Ranking) => {
    const label = t(`period.${r.key}`);
    const done = subscribed.get(r.key);
    if (done !== undefined) {
      return <li key={r.key} className="subs-rank-row is-done">
        <input type="checkbox" checked disabled aria-label={label} />
        <span className="subs-rank-name">{label}</span>
        <span className="subs-rank-done">{t("subscribed", { count: done })}</span>
      </li>;
    }
    return <li key={r.key} className={`subs-rank-row${picks[r.key] ? " is-on" : ""}`}>
      <label className="subs-rank-pick">
        <input type="checkbox" checked={!!picks[r.key]} disabled={busy} onChange={(e) => setPicks((p) => ({ ...p, [r.key]: e.target.checked }))} />
        <span className="subs-rank-name">{label}</span>
      </label>
      <TopPicker label={t("topLabel", { period: label })} value={tops[r.key]}
        onChange={(top) => { setTops((v) => ({ ...v, [r.key]: top })); setPicks((p) => ({ ...p, [r.key]: true })); }} />
    </li>;
  };

  return <Dialog.Root open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-artist-dialog subs-rank-dialog">
        <div className="subs-first-run-head">
          <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
          <UnofficialMark />
        </div>
        <div className="k-field">
          <span className="k-field-label" id="subs-rank-list">{t("list")}</span>
          <ul className="subs-rank-list" aria-labelledby="subs-rank-list">{RANKINGS.filter((r) => !r.explicit).map(row)}</ul>
        </div>
        {showExplicit && <div className="k-field">
          <div className="subs-option">
            <span className="subs-option-text">{t("explicit")}</span>
            <Switch label={t("explicit")} disabled={busy} checked={explicitOn} onCheckedChange={setExplicitOn} />
          </div>
          {explicitOn && <ul className="subs-rank-list" aria-label={t("explicitList")}>{RANKINGS.filter((r) => r.explicit).map(row)}</ul>}
        </div>}
        <div className="k-field">
          <span className="k-field-label" id="subs-rank-library">{t("library")}</span>
          {rankings.length > 0
            ? <LibrarySelect label={t("library")} disabled={busy}
                value={chosen.existingId} onChange={(existingId) => set({ mode: "existing", existingId })} />
            : <div className="k-radio-cards" role="radiogroup" aria-labelledby="subs-rank-library">
              <div className={`k-radio-card subs-rank-new${chosen.mode === "new" ? " is-on" : ""}`}>
                <label className="subs-rank-card-head">
                  <input type="radio" name="subs-rank-library" disabled={busy} checked={chosen.mode === "new"} onChange={() => set({ mode: "new" })} />
                  <span className="k-radio-title">{t("newLibrary")}</span>
                </label>
                {chosen.mode === "new" && <div className="subs-rank-new-fields">
                  <NewLibraryFields compact value={chosen} onChange={set} disabled={busy} />
                </div>}
              </div>
              <label className={`k-radio-card subs-rank-existing${chosen.mode === "existing" ? " is-on" : ""}`}>
                <input type="radio" name="subs-rank-library" disabled={busy} checked={chosen.mode === "existing"} onChange={() => set({ mode: "existing" })} />
                <span className="k-radio-title">{t("existingLibrary")}</span>
                {chosen.mode === "existing" && <Select label={t("existingLibrary")} disabled={busy || !libraries.ready}
                  value={chosen.existingId} onChange={(existingId) => set({ existingId })} options={libraries.options} />}
              </label>
            </div>}
          {otherLibrary && <span className="subs-rank-hint subs-rank-note is-warn"><Info size={12} aria-hidden="true" />{t("otherLibrary")}</span>}
        </div>
        <div className="subs-option">
          <span className="subs-option-text">{t("manga")}</span>
          <Switch label={t("manga")} disabled={busy} checked={manga} onCheckedChange={setManga} />
        </div>
        {error && <p className="k-field-error" role="alert"><CircleAlert size={14} aria-hidden="true" />{error}</p>}
        <div className="k-dialog-foot">
          <span className="k-grow subs-rank-foot-note">{open === 0 ? t("allDone") : ""}</span>
          <button type="button" className="k-btn" disabled={busy} onClick={onClose}><span className="k-label">{t("cancel")}</span></button>
          <button type="button" className="k-btn is-primary" disabled={busy || picked.length === 0 || !libraryReady} onClick={() => void subscribe()}>
            <span className="k-label">{busy ? t("subscribing") : t("subscribe", { count: Math.max(picked.length, 1) })}</span>
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** 榜单的订阅设置（原型 R5–R6）：改名次与漫画；榜单与图库是订阅时定的。名次改少后已收的图留着（不做自动清理）。 */
export function RankingSettingsDialog({ subscription, onClose, onSaved }: {
  subscription: Subscription; onClose: () => void; onSaved: (saved: Subscription) => void;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "ranking" });
  const { t: ts } = useTranslation("subscriptions");
  const current = subscription.target.kind === "pixivRanking" ? subscription.target.top : 50;
  const [top, setTop] = useState<Top>((TOPS as readonly number[]).includes(current) ? current as Top : 50);
  const [manga, setManga] = useState(subscription.includeManga);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setBusy(true); setError(null);
    subscriptionSetOptions(subscription.id, subscription.includeExplicit, manga, top)
      .then((saved) => { onSaved(saved); onClose(); }, (e) => { setError(t("saveFailed", { error: errorText(e) })); setBusy(false); });
  };
  return <Dialog.Root open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog subs-artist-dialog">
        <Dialog.Title className="k-dialog-title">{t("settingsTitle")}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{displayName(ts, subscription)}</Dialog.Description>
        <div className="k-field">
          <span className="k-field-label">{t("ranks")}</span>
          <TopPicker label={t("ranks")} value={top} onChange={setTop} />
        </div>
        <div className="subs-option">
          <span className="subs-option-text">{t("manga")}</span>
          <Switch label={t("manga")} disabled={busy} checked={manga} onCheckedChange={setManga} />
        </div>
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
