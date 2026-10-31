import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui/react/dialog";
import { Sparkles, Tag, X } from "lucide-react";
import type { LegacyNameGroup } from "../bindings/LegacyNameGroup";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import type { LegacyNameMigrationPreview } from "../bindings/LegacyNameMigrationPreview";
import type { LegacyNameResolution } from "../bindings/LegacyNameResolution";
import { confirmLegacyNames, onLibraryEvent, onSafeModeSetting, planLegacyNames, previewLegacyNames } from "../ipc";
import { languageName } from "../tags/languages";


/** 向导确认后通知各处的“旧名称待确认”提示重新读取。 */
const CHANGED = "kinshoko:legacy-names-changed";
const PREVIEW_PAGE = 20;

const key = (group: LegacyNameGroup) => `${group.catalogId}/${group.lang}`;
function choice(group: LegacyNameGroup, value: string): LegacyNameResolution {
  if (value === "default") return { kind: "followDefault" };
  if (value === "preference") return { kind: "keepPreference" };
  const source = group.sources[Number(value.slice(7))];
  return { kind: "keepLegacy", libraryId: source.libraryId, localTagId: source.localTagId };
}
/** 不同旧库对同一个标签有不同叫法。 */
const differentOldNames = (group: LegacyNameGroup) => new Set(group.sources.map((source) => source.legacyName)).size > 1;
/** “剩下的都用默认”只处理：还没选、没有已定的叫法、旧叫法只有一种。冲突项必须逐个决定。 */
const followsDefaultInBulk = (group: LegacyNameGroup, selected: Record<string, string>) =>
  !selected[key(group)] && group.existingPreference === null && !differentOldNames(group);

/**
 * 确认旧名称（原“旧资料库名称迁移”，#98）：一次一个标签，进度条 + 上一个 / 下一个。
 * 每个统一标签和语言只选一条全局规则：用默认名、保留某个旧库的旧名或保留已定的叫法；另一个名字留作别名。
 * 全部选完后先由核心预览最终显示，确认后一次写入；取消或关闭会放弃本次草稿，不写入任何东西。
 */
export function LegacyNameWizard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("legacyNames");
  const [view, setView] = useState<LegacyNameMigrationWorkspace | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<LegacyNameMigrationPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewChoiceKey, setPreviewChoiceKey] = useState("");
  const [previewPage, setPreviewPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  function reset() { generation.current++; setView(null); setSelected({}); setPage(0); setError(null); setSaved(false); setBusy(false); }
  useEffect(() => {
    let alive = true;
    const stop = onSafeModeSetting(() => { if (alive) reset(); });
    return () => { alive = false; generation.current++; void stop.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  async function run(action: () => Promise<LegacyNameMigrationWorkspace>, confirming = false) {
    const request = ++generation.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      const next = await action();
      if (request !== generation.current) return;
      setView(next); setSaved(confirming); setSelected({}); setPage(0);
      if (confirming) window.dispatchEvent(new Event(CHANGED));
    } catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  useEffect(() => { if (open) void run(planLegacyNames); else reset(); }, [open]);

  const groups = view?.plan.groups ?? [];
  const reviewing = groups.length > 0 && page >= groups.length;
  const group = reviewing ? undefined : groups[page];
  const libraryNames = new Map(view?.libraries.map((entry) => [entry.library.id, entry.library.name]));
  const libraryName = (id: string) => libraryNames.get(id) ?? id;
  const value = group ? selected[key(group)] ?? "" : "";
  const chosen = groups.filter((entry) => selected[key(entry)]).length;
  const complete = groups.length > 0 && chosen === groups.length;
  const decisions = complete ? groups.map((entry) => ({ catalogId: entry.catalogId, lang: entry.lang, resolution: choice(entry, selected[key(entry)]) })) : [];
  const choiceKey = complete ? JSON.stringify(decisions) : "";
  const validPreview = preview !== null && previewChoiceKey === choiceKey && preview.revision === view?.plan.revision;
  const bulk = groups.filter((entry) => followsDefaultInBulk(entry, selected));
  const firstUnchosen = (from: Record<string, string>) => groups.findIndex((entry) => !from[key(entry)]);
  function bulkFollow() {
    const next = { ...selected };
    for (const entry of bulk) next[key(entry)] = "default";
    setSelected(next);
    const left = firstUnchosen(next);
    setPage(left >= 0 ? left : groups.length);
  }
  /** 下一个；最后一项之后，还有没选的就回到第一个没选的，全部选完才进入确认。 */
  function forward() {
    if (page < groups.length - 1) { setPage(page + 1); return; }
    const left = firstUnchosen(selected);
    setPage(left >= 0 ? left : groups.length);
  }
  useEffect(() => {
    let alive = true;
    const request = generation.current;
    setPreview(null); setPreviewChoiceKey(""); setPreviewPage(0); setPreviewBusy(false);
    if (!view || !complete) return;
    setPreviewBusy(true);
    void previewLegacyNames(view.plan.revision, decisions).then((next) => {
      if (alive && request === generation.current) { setPreview(next); setPreviewChoiceKey(choiceKey); }
    }).catch((reason) => { if (alive && request === generation.current) setError(String(reason)); }).finally(() => { if (alive && request === generation.current) setPreviewBusy(false); });
    return () => { alive = false; };
  }, [view, selected]);

  const options = group ? [
    // 选项名用 #78 规定的“跟随默认”与“保留为全局偏好”，具体名称紧跟其后。
    { value: "default", title: group.defaultName ? t("option.followDefaultNamed", { name: group.defaultName }) : t("option.followDefault"),
      desc: group.existingPreference ? t("option.withdrawsPreference", { name: group.existingPreference }) : group.defaultName ? t("option.followsUpdates") : t("option.noDefault") },
    ...group.sources.map((source, index) => ({ value: `legacy:${index}`, title: t("option.keepAsPreference", { name: source.legacyName }),
      desc: t("option.savedFrom", { library: libraryName(source.libraryId) }) })),
    ...(group.existingPreference !== null ? [{ value: "preference", title: t("option.keepAsPreference", { name: group.existingPreference }), desc: t("option.keepPrevious") }] : []),
  ] : [];
  const shown = group ? group.defaultName ?? group.sources[0]?.legacyName ?? group.catalogId : "";
  // 预览表的标签列写标签名（默认名，没有时用旧名），不写内部编号。
  const tagLabel = (catalogId: string) => {
    const entry = groups.find((candidate) => candidate.catalogId === catalogId);
    return entry?.defaultName ?? entry?.sources[0]?.legacyName ?? t("unnamed");
  };
  const outcomes = validPreview ? preview!.outcomes : [];

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!busy || next) onOpenChange(next); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="k-backdrop" />
      <Dialog.Popup className="k-dialog k-wizard legacy-name-migration">
        <Dialog.Close className="k-icon-btn k-dialog-x" aria-label={t("close")}><X size={16} aria-hidden="true" /></Dialog.Close>
        <Dialog.Title className="k-dialog-title">{t("title")}</Dialog.Title>
        <Dialog.Description className="k-dialog-desc">{t("lead")}</Dialog.Description>
        {busy && <p className="k-set-note" role="status">{t("busy")}</p>}
        {error && <p className="k-set-error" role="alert">{error}</p>}
        {view?.libraries.filter((entry) => entry.unavailable).map((entry) => <p key={entry.library.id} className="k-set-note" role="status">{t("libraryOffline", { library: entry.library.name, reason: entry.unavailable })}</p>)}
        {saved && <p role="status">{t("saved")}</p>}
        {view && groups.length === 0 && <p className="k-set-note">{t("none")}</p>}
        {groups.length > 0 && <>
          <div className="k-steps-row">
            <div className="k-steps" aria-hidden="true">{groups.length <= 12
              ? groups.map((entry, index) => <i key={key(entry)} className={index === page ? "is-current" : selected[key(entry)] ? "is-done" : ""} />)
              : <i className="is-done" style={{ flex: "none", width: `${(chosen / groups.length) * 100}%` }} />}</div>
            <span className="k-steps-count tabular">{reviewing ? t("reviewStep") : t("step", { current: page + 1, total: groups.length })}</span>
          </div>
          <p className="k-set-note" role="status">{t("chosen", { chosen, total: groups.length })}</p>
        </>}
        {group && <>
          <div className="k-big-tag">
            <span className="k-big-tag-icon" aria-hidden="true"><Tag size={18} /></span>
            <div><div className="k-big-tag-name">{shown}</div>
              <div className="k-list-desc">{t("usedIn", { count: group.affectedLibraries.length, libraries: group.affectedLibraries.map(libraryName).join(t("librarySeparator")) })}</div></div>
          </div>
          {differentOldNames(group) && <p className="k-list-desc is-warn">{t("differentNames")}</p>}
          {group.existingPreference !== null && group.sources.some((source) => source.legacyName !== group.existingPreference) &&
            <p className="k-list-desc is-warn">{t("differsFromPreference", { name: group.existingPreference })}</p>}
          <div className="k-radio-cards" role="radiogroup" aria-label={t("choiceLabel")}>
            {options.map((option) => <label key={option.value} className={`k-radio-card${value === option.value ? " is-on" : ""}`}>
              <input type="radio" name={`legacy-${key(group)}`} value={option.value} checked={value === option.value} disabled={busy}
                onChange={() => setSelected({ ...selected, [key(group)]: option.value })} />
              <span><span className="k-radio-title">{option.title}</span><span className="k-radio-desc">{option.desc}</span></span>
            </label>)}
          </div>
          <p className="k-set-note">{t("aliasNote")}</p>
        </>}
        {reviewing && <>
          {previewBusy && <p role="status">{t("checking")}</p>}
          {validPreview && <>
            <table className="k-preview-table" aria-label={t("preview.label")}>
              <thead><tr><th>{t("preview.tag")}</th><th>{t("preview.display")}</th><th>{t("preview.preference")}</th></tr></thead>
              <tbody>{outcomes.slice(previewPage * PREVIEW_PAGE, (previewPage + 1) * PREVIEW_PAGE).map((outcome) => <tr key={`${outcome.catalogId}/${outcome.lang}`}>
                <td>{t("preview.tagInLanguage", { tag: tagLabel(outcome.catalogId), language: languageName(outcome.lang) })}</td><td>{outcome.displayName}</td><td>{outcome.preferenceName ?? t("preview.noPreference")}</td></tr>)}</tbody>
            </table>
            {outcomes.length > PREVIEW_PAGE && <div className="k-dialog-foot is-tight">
              <span className="k-set-note">{previewPage * PREVIEW_PAGE + 1}–{Math.min((previewPage + 1) * PREVIEW_PAGE, outcomes.length)} / {outcomes.length}</span>
              <span className="k-grow" />
              <button type="button" className="k-btn is-sm" disabled={previewPage === 0} onClick={() => setPreviewPage(previewPage - 1)}><span className="k-label">{t("preview.previousPage")}</span></button>
              <button type="button" className="k-btn is-sm" disabled={(previewPage + 1) * PREVIEW_PAGE >= outcomes.length} onClick={() => setPreviewPage(previewPage + 1)}><span className="k-label">{t("preview.nextPage")}</span></button>
            </div>}
          </>}
        </>}
        <div className="k-dialog-foot">
          {groups.length > 0 && !reviewing && !saved && <button type="button" className="k-btn is-ghost is-flush" disabled={busy || bulk.length === 0} onClick={bulkFollow}><span className="k-label">{t("bulk", { count: bulk.length })}</span></button>}
          <span className="k-grow" />
          {groups.length === 0 || saved
            ? <Dialog.Close className="k-btn is-primary"><span className="k-label">{t("done")}</span></Dialog.Close>
            : <>
              <Dialog.Close className="k-btn" disabled={busy}><span className="k-label">{t("cancel")}</span></Dialog.Close>
              <button type="button" className="k-btn" disabled={busy || page === 0} onClick={() => setPage(page - 1)}><span className="k-label">{t("previous")}</span></button>
              {reviewing
                ? <button type="button" className="k-btn is-primary" disabled={busy || !validPreview} onClick={() => { if (view && validPreview) void run(() => confirmLegacyNames(view.plan.revision, decisions), true); }}><span className="k-label">{t("confirm")}</span></button>
                : <button type="button" className="k-btn is-primary" disabled={busy} onClick={forward}><span className="k-label">{t("next")}</span></button>}
            </>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** 词表连续变化时，两次旧名称检查之间至少隔开这么久（#142）。 */
const REREAD_DELAY_MS = 200;

/**
 * 读取待确认的旧名称；词表变化、导入结束或向导确认后重读，安全模式切换时先清空。
 * 自动打标每写一张图都会发 vocabularyChanged，而 plan_legacy_names 很重（#142）：同一时刻最多一次在途，
 * 在途或等待期间来的变化只记下，返回后最多补读一次。
 */
function usePendingLegacyNames(match: (group: LegacyNameGroup) => boolean, deps: unknown[]) {
  const [count, setCount] = useState(0);
  const matcher = useRef(match);
  matcher.current = match;
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let running = false;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setCount(0);
    const start = () => {
      timer = undefined;
      if (!alive) return;
      stale = false;
      running = true;
      const request = ++generation;
      void planLegacyNames().then((view) => {
        if (alive && request === generation) setCount(view?.plan.groups.filter((group) => matcher.current(group)).length ?? 0);
      }).catch(() => {}).finally(() => {
        running = false;
        if (alive && stale) schedule();
      });
    };
    const schedule = () => { if (!running && timer === undefined) timer = setTimeout(start, REREAD_DELAY_MS); };
    const read = () => { stale = true; schedule(); };
    start();
    const unlisten = onLibraryEvent((event) => { if (event.kind === "vocabularyChanged" || event.kind === "taskFinished") read(); });
    const safeStop = onSafeModeSetting(() => { generation++; setCount(0); });
    window.addEventListener(CHANGED, read);
    return () => {
      alive = false; generation++;
      clearTimeout(timer);
      window.removeEventListener(CHANGED, read);
      void unlisten.then((stop) => stop()).catch(() => {}); void safeStop.then((stop) => stop()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return count;
}

/** 打开带旧名称的图库时的横幅：保留原显示，提供“逐个确认”。 */
export function LegacyNameMigrationNotice({ libraryId, safe, onOpen }: { libraryId: string; safe: boolean; onOpen: () => void }) {
  const { t } = useTranslation("legacyNames", { keyPrefix: "notice" });
  const pending = usePendingLegacyNames((group) => group.sources.some((source) => source.libraryId === libraryId), [libraryId, safe]);
  return pending > 0 ? <p className="legacy-name-notice k-notice" role="status"><Sparkles size={14} aria-hidden="true" />
    <span className="k-grow"><b>{t("title")}</b>{t("body", { count: pending })}</span>
    <button type="button" className="k-btn is-sm" onClick={onOpen}><span className="k-label">{t("open")}</span></button></p> : null;
}

/** 设置 › 标签 › 显示名底部的提示条。 */
export function LegacyNameBanner({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation("legacyNames");
  const pending = usePendingLegacyNames(() => true, []);
  if (pending === 0 || !onOpen) return null;
  return <div className="k-notice legacy-name-banner" role="status"><Sparkles size={15} aria-hidden="true" />
    <span className="k-grow"><b>{t("banner.title", { count: pending })}</b>{t("banner.body")}</span>
    <button type="button" className="k-btn is-sm" onClick={onOpen}><span className="k-label">{t("notice.open")}</span></button></div>;
}
