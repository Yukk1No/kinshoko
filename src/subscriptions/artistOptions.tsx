import { Library } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Backlog } from "../bindings/Backlog";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { useSaveDestination } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

/** 订阅画师时由画师选的部分（#366）：资料库、旧作收多少、漫画与 R-18。 */
export type ArtistChoices = {
  libraryId: string;
  backlog: Backlog["kind"];
  /** “最近几张”输入框里的原文；只在选了最近时用。 */
  recentCount: string;
  includeManga: boolean;
  includeExplicit: boolean;
};

export const RECENT_DEFAULT = 20;
const RECENT_MAX = 1000;

export function initialChoices(libraryId: string): ArtistChoices {
  return { libraryId, backlog: "newOnly", recentCount: String(RECENT_DEFAULT), includeManga: false, includeExplicit: true };
}

/** 选好的旧作；最近几张填得不对时为空。 */
export function backlogOf(choices: ArtistChoices): Backlog | null {
  if (choices.backlog !== "recent") return { kind: choices.backlog };
  const count = Number(choices.recentCount);
  return Number.isInteger(count) && count >= 1 && count <= RECENT_MAX ? { kind: "recent", count } : null;
}

/**
 * R-18 选项只在登录着、账号打开了 R-18 显示、安全模式关着时出现（#366：安全模式开着时对话框里不出现 R-18 字样）；
 * 不出现时按默认收。
 */
export function explicitChoice(status: SubscriptionStatus, safe: boolean): boolean {
  return status.login.state === "loggedIn" && status.login.account.explicitAllowed && !safe;
}

/** 从 pixiv 关注导入只在登录着时出现。 */
export function followingChoice(status: SubscriptionStatus): boolean {
  return status.login.state === "loggedIn";
}

/** 能收进去的资料库（开着、在线的）。 */
export function useLibraryOptions() {
  const { providers, ready } = useSaveDestination();
  const options = providers.filter((p) => !p.registration.unavailable && p.sidebar)
    .map((p) => ({ value: p.registration.library.id, label: p.registration.library.name }));
  return { options, ready };
}

/**
 * 资料库、旧作、漫画与 R-18 几行。`backlogAs` 为 cards 时旧作是三张单选卡片（订阅画师），为 select 时是下拉
 * （从关注导入，免得对话框太高），为空时不显示（订阅设置里不改旧作与资料库）。
 */
export function ArtistOptionFields({ value, onChange, backlogAs, showExplicit, disabled }: {
  value: ArtistChoices; onChange: (value: ArtistChoices) => void;
  backlogAs: "cards" | "select" | null; showExplicit: boolean; disabled?: boolean;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "artist" });
  const libraries = useLibraryOptions();
  const set = (patch: Partial<ArtistChoices>) => onChange({ ...value, ...patch });
  const recentCount = backlogOf({ ...value, backlog: "recent" })?.kind === "recent" ? Number(value.recentCount) : RECENT_DEFAULT;
  return <>
    {backlogAs && <div className="k-field">
      <span className="k-field-label">{t("library")}</span>
      <Select label={t("library")} icon={<Library size={16} aria-hidden="true" />} disabled={disabled || !libraries.ready}
        value={value.libraryId} onChange={(libraryId) => set({ libraryId })} options={libraries.options} />
    </div>}
    {backlogAs === "cards" && <div className="k-field" role="radiogroup" aria-label={t("backlog")}>
      <span className="k-field-label" aria-hidden="true">{t("backlog")}</span>
      <div className="k-radio-cards">
        <label className={`k-radio-card subs-backlog-card${value.backlog === "newOnly" ? " is-on" : ""}`}>
          <input type="radio" name="artist-backlog" disabled={disabled} checked={value.backlog === "newOnly"} onChange={() => set({ backlog: "newOnly" })} />
          <span className="k-radio-title">{t("newOnly")}</span>
        </label>
        <label className={`k-radio-card subs-backlog-card subs-recent-card${value.backlog === "recent" ? " is-on" : ""}`}>
          <input type="radio" name="artist-backlog" disabled={disabled} checked={value.backlog === "recent"} onChange={() => set({ backlog: "recent" })} />
          <span className="k-radio-title k-grow">{t("recent")}</span>
          <span className="k-input is-num" aria-invalid={value.backlog === "recent" && !backlogOf(value) ? true : undefined}>
            <input inputMode="numeric" aria-label={t("recentLabel")} disabled={disabled} value={value.recentCount}
              onFocus={() => set({ backlog: "recent" })}
              onChange={(e) => set({ backlog: "recent", recentCount: e.target.value.replace(/[^\d]/g, "") })} />
          </span>
          <span className="k-field-unit">{t("recentUnit")}</span>
        </label>
        <label className={`k-radio-card subs-backlog-card${value.backlog === "all" ? " is-on" : ""}`}>
          <input type="radio" name="artist-backlog" disabled={disabled} checked={value.backlog === "all"} onChange={() => set({ backlog: "all" })} />
          <span className="k-radio-title">{t("all")}</span>
        </label>
      </div>
    </div>}
    {backlogAs === "select" && <div className="k-field">
      <span className="k-field-label">{t("backlog")}</span>
      <Select label={t("backlog")} disabled={disabled} value={value.backlog}
        onChange={(backlog) => set({ backlog, recentCount: String(recentCount) })}
        options={[
          { value: "newOnly", label: t("newOnly") },
          { value: "recent", label: t("recentOption", { count: recentCount }) },
          { value: "all", label: t("all") },
        ]} />
    </div>}
    <div className="subs-option">
      <span className="subs-option-text">{t("manga")}</span>
      <Switch label={t("manga")} disabled={disabled} checked={value.includeManga} onCheckedChange={(includeManga) => set({ includeManga })} />
    </div>
    {showExplicit && <div className="subs-option">
      <span className="subs-option-text">{t("explicit")}</span>
      <Switch label={t("explicit")} disabled={disabled} checked={value.includeExplicit} onCheckedChange={(includeExplicit) => set({ includeExplicit })} />
    </div>}
  </>;
}
