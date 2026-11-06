import { useState } from "react";
import { FolderPlus, Library } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Backlog } from "../bindings/Backlog";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { CreateLibraryDialog, type CreatedLibrary } from "../library/CreateLibrary";
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
 * R-18 选项只在登录着、账号打开了 R-18 显示时出现；不出现时按默认收。安全模式只防社死：开着时照样出现，
 * 只是 R-18 的图不上屏（维护者 2026-11-02，#370）。
 */
export function explicitChoice(status: SubscriptionStatus): boolean {
  return status.login.state === "loggedIn" && status.login.account.explicitAllowed;
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

/** 旧作几张单选卡片的文字。 */
export type BacklogLabels = { newOnly: string; recent: string; recentUnit: string; recentLabel: string; all: string };

/**
 * 旧作收多少的三张单选卡片：只收新作／最近几张（卡片里带输入框）／全部。`inline` 时三张排成一行（收藏夹的公开、
 * 非公开收藏各一行，#371），否则竖排。
 */
export function BacklogCards({ name, label, labels, value, onChange, disabled, inline }: {
  /** 单选组的名字，同一个对话框里几组不能重。 */
  name: string; label: string; labels: BacklogLabels;
  value: Pick<ArtistChoices, "backlog" | "recentCount">;
  onChange: (value: Pick<ArtistChoices, "backlog" | "recentCount">) => void;
  disabled?: boolean; inline?: boolean;
}) {
  const set = (patch: Partial<Pick<ArtistChoices, "backlog" | "recentCount">>) => onChange({ ...value, ...patch });
  const invalid = value.backlog === "recent" && !backlogOf({ ...initialChoices(""), ...value });
  return <div className="k-field" role="radiogroup" aria-label={label}>
    <span className="k-field-label" aria-hidden="true">{label}</span>
    <div className={`k-radio-cards${inline ? " subs-backlog-row" : ""}`}>
      <label className={`k-radio-card subs-backlog-card${value.backlog === "newOnly" ? " is-on" : ""}`}>
        <input type="radio" name={name} disabled={disabled} checked={value.backlog === "newOnly"} onChange={() => set({ backlog: "newOnly" })} />
        <span className="k-radio-title">{labels.newOnly}</span>
      </label>
      <label className={`k-radio-card subs-backlog-card subs-recent-card${value.backlog === "recent" ? " is-on" : ""}`}>
        <input type="radio" name={name} disabled={disabled} checked={value.backlog === "recent"} onChange={() => set({ backlog: "recent" })} />
        <span className="k-radio-title k-grow">{labels.recent}</span>
        <span className="k-input is-num" aria-invalid={invalid ? true : undefined}>
          <input inputMode="numeric" aria-label={labels.recentLabel} disabled={disabled} value={value.recentCount}
            onFocus={() => set({ backlog: "recent" })}
            onChange={(e) => set({ backlog: "recent", recentCount: e.target.value.replace(/[^\d]/g, "") })} />
        </span>
        <span className="k-field-unit">{labels.recentUnit}</span>
      </label>
      <label className={`k-radio-card subs-backlog-card${value.backlog === "all" ? " is-on" : ""}`}>
        <input type="radio" name={name} disabled={disabled} checked={value.backlog === "all"} onChange={() => set({ backlog: "all" })} />
        <span className="k-radio-title">{labels.all}</span>
      </label>
    </div>
  </div>;
}

/** 下拉里「新建图库…」一项的值；不会是资料库 ID。 */
const NEW_LIBRARY = "\u0000new-library";

/**
 * 订阅里选图库的下拉（#442）：最后一项「新建图库…」叠一层新建图库对话框，建好后选中新图库、不切换主窗口；
 * 取消时仍是原来的选项。新图库进登记列表之前先补在列表里，免得下拉一时显示不出它。
 */
export function LibrarySelect({ label, value, onChange, disabled }: { label: string; value: string; onChange: (libraryId: string) => void; disabled?: boolean }) {
  const { t } = useTranslation("library", { keyPrefix: "picker" });
  const libraries = useLibraryOptions();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLibrary | null>(null);
  const known = created === null || libraries.options.some((o) => o.value === created.id)
    ? libraries.options : [...libraries.options, { value: created.id, label: created.name }];
  const options = [...known, {
    value: NEW_LIBRARY,
    label: <span className="subs-new-library"><FolderPlus size={14} aria-hidden="true" />{t("create")}</span>,
  }];
  return <>
    <Select label={label} icon={<Library size={16} aria-hidden="true" />} disabled={disabled || !libraries.ready}
      value={value} onChange={(next) => { if (next === NEW_LIBRARY) setCreating(true); else onChange(next); }} options={options} />
    {creating && <CreateLibraryDialog onClose={() => setCreating(false)}
      onCreated={(library) => { setCreated(library); setCreating(false); onChange(library.id); }} />}
  </>;
}

/** 图库下拉，带栏名。 */
export function LibraryField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (libraryId: string) => void; disabled?: boolean }) {
  return <div className="k-field">
    <span className="k-field-label">{label}</span>
    <LibrarySelect label={label} value={value} onChange={onChange} disabled={disabled} />
  </div>;
}

/** 漫画与 R-18 两个开关；R-18 只在 `showExplicit` 时出现。 */
export function KindSwitches({ value, onChange, showExplicit, disabled }: {
  value: Pick<ArtistChoices, "includeManga" | "includeExplicit">;
  onChange: (patch: Partial<Pick<ArtistChoices, "includeManga" | "includeExplicit">>) => void;
  showExplicit: boolean; disabled?: boolean;
}) {
  const { t } = useTranslation("subscriptions", { keyPrefix: "artist" });
  return <>
    <div className="subs-option">
      <span className="subs-option-text">{t("manga")}</span>
      <Switch label={t("manga")} disabled={disabled} checked={value.includeManga} onCheckedChange={(includeManga) => onChange({ includeManga })} />
    </div>
    {showExplicit && <div className="subs-option">
      <span className="subs-option-text">{t("explicit")}</span>
      <Switch label={t("explicit")} disabled={disabled} checked={value.includeExplicit} onCheckedChange={(includeExplicit) => onChange({ includeExplicit })} />
    </div>}
  </>;
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
  const set = (patch: Partial<ArtistChoices>) => onChange({ ...value, ...patch });
  const recentCount = backlogOf({ ...value, backlog: "recent" })?.kind === "recent" ? Number(value.recentCount) : RECENT_DEFAULT;
  return <>
    {backlogAs && <LibraryField label={t("library")} value={value.libraryId} onChange={(libraryId) => set({ libraryId })} disabled={disabled} />}
    {backlogAs === "cards" && <BacklogCards name="artist-backlog" label={t("backlog")} value={value} onChange={set} disabled={disabled}
      labels={{ newOnly: t("newOnly"), recent: t("recent"), recentUnit: t("recentUnit"), recentLabel: t("recentLabel"), all: t("all") }} />}
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
    <KindSwitches value={value} onChange={set} showExplicit={showExplicit} disabled={disabled} />
  </>;
}
