import { useEffect, useRef, useState } from "react";
import { PenLine, Search, Tag, X } from "lucide-react";
import type { CatalogNameEdit } from "../bindings/CatalogNameEdit";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { editTagName, externalSuggestions, inspectTagCatalog, mapTagExternal, onSafeModeSetting, setSourceNameLang } from "../ipc";
import { SettingsRow, StatusPill } from "../ui/SettingsList";
import { currentName } from "../tags/catalogName";
import { sourceLanguages } from "../tags/languages";
import { Select } from "../ui/Select";
import { Combobox } from "../ui/Combobox";
import { useUiLang } from "../i18n";
import { externalOptions } from "./EagleTagStep";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/instance";
import type { TagNamespace } from "../bindings/TagNamespace";

const LIMIT = 80;
/** 行描述里的类别名；一般标签不写。 */
const namespaceName = (namespace: TagNamespace) => namespace === "general" ? "" : i18n.t(`tags:namespaceOption.${namespace}`);

/**
 * 设置 › 标签 › 显示名：显示名先用名称偏好（界面上写“已改名”），没有时用默认名称；改一次在所有图库生效。
 * 别名单独用于查找。每行只标出状态，点“改名”展开一个标签的编辑，一次只编辑一个。
 * 图库带来的来源名称（例如 Eagle 原有标签，#217）在展开后列出，可以改它的语言；
 * “只看没有外部对应的”列出这类标签，展开后可以补上外部对应，或直接改显示名。
 * `focus`：从别处（例如详情面板的改名框，#182）打开时要定位的统一标签，排在最前并展开。
 */
export function TagNamePanel({ focus }: { focus?: string } = {}) {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const uiLang = useUiLang();
  const { t } = useTranslation("tagSettings");
  const [lang, setLang] = useState<string>(uiLang);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(focus ?? null);
  const [preferencesOnly, setPreferencesOnly] = useState(false);
  const [unmappedOnly, setUnmappedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const run = async (action: () => Promise<TagCatalogWorkspace>) => {
    const request = ++generation.current;
    setBusy(true); setError(null);
    try { const result = await action(); if (request === generation.current) setWorkspace(result); }
    catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    let alive = true;
    void run(inspectTagCatalog);
    const unlisten = onSafeModeSetting(() => {
      if (!alive) return;
      generation.current++;
      setWorkspace(null); setError(null); setBusy(false); setEditing(null);
    });
    return () => { alive = false; generation.current++; void unlisten.then((stop) => stop()).catch(() => {}); };
  }, []);
  const language = lang.trim();
  const needle = filter.trim().toLocaleLowerCase();
  const pending = new Set(workspace?.catalog.mappings.filter((mapping) => mapping.nameProvenance === "pending").map((mapping) => mapping.catalogId));
  const matches = workspace?.catalog.tags.filter((tag) => (!preferencesOnly || tag.namePreferences.some((entry) => entry.lang === language))
    && (!unmappedOnly || tag.external.length === 0)
    && [currentName(tag, language), ...tag.names.map((entry) => entry.name), ...tag.aliases.map((entry) => entry.name), ...tag.external.map((entry) => entry.name)]
      .some((name) => name.toLocaleLowerCase().includes(needle))) ?? [];
  const focused = matches.findIndex((tag) => tag.id === focus);
  if (focused > 0) matches.unshift(...matches.splice(focused, 1));
  const shown = matches.slice(0, LIMIT);
  return <section className="tag-names" aria-label={t("names.label")} aria-busy={busy}>
    <div className="k-set-toolbar">
      <label className="k-search"><Search size={14} aria-hidden="true" />
        <input aria-label={t("names.filter")} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("names.filterPlaceholder")} /></label>
      <label className="k-check"><input type="checkbox" checked={preferencesOnly} onChange={(event) => setPreferencesOnly(event.target.checked)} />{t("names.renamedOnly")}</label>
      <label className="k-check"><input type="checkbox" checked={unmappedOnly} onChange={(event) => setUnmappedOnly(event.target.checked)} />{t("names.unmappedOnly")}</label>
      <label className="k-lang" title={t("names.lang")}>{t("names.langShort")}<input className="k-input" aria-label={t("names.lang")} value={lang} onChange={(event) => setLang(event.target.value)} placeholder="zh-CN" /></label>
    </div>
    {busy && !workspace && <p className="k-set-note" role="status">{t("names.loading")}</p>}
    {error && <p className="k-set-error" role="alert">{error}</p>}
    {!workspace && !busy && <button type="button" className="k-btn is-sm" onClick={() => void run(inspectTagCatalog)}><span className="k-label">{t("names.load")}</span></button>}
    {workspace && <>
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} className="k-set-note" role="status">{t("libraryUnavailable", { name: library.name, reason: unavailable })}</p>)}
      {shown.length === 0 ? <p className="k-set-note">{workspace.catalog.tags.length === 0 ? t("noTags") : t("names.noMatch")}</p>
        : <ul className="k-list k-set-list" aria-label={t("names.list")}>
          {shown.map((tag) => <NameRow key={`${tag.id}/${language}`} tag={tag} lang={language} busy={busy} pending={pending.has(tag.id)}
            mappings={workspace.catalog.mappings.filter((mapping) => mapping.catalogId === tag.id)}
            libraryName={(id) => workspace.libraries.find((entry) => entry.library.id === id)?.library.name ?? t("names.library")}
            open={editing === tag.id} onToggle={() => setEditing(editing === tag.id ? null : tag.id)}
            onEdit={(edit) => void run(() => editTagName(tag.id, edit))}
            onLocal={(action) => void run(async () => { await action(); return inspectTagCatalog(); })} />)}
        </ul>}
      {matches.length > shown.length && <p className="k-set-note">{t("names.truncated", { total: matches.length, shown: shown.length })}</p>}
    </>}
  </section>;
}

function NameRow({ tag, lang, busy, pending, mappings, libraryName, open, onToggle, onEdit, onLocal }: {
  tag: CatalogTag; lang: string; busy: boolean; pending: boolean; mappings: LibraryTagMapping[]; libraryName: (id: string) => string;
  open: boolean; onToggle: () => void; onEdit: (edit: CatalogNameEdit) => void; onLocal: (action: () => Promise<unknown>) => void;
}) {
  const { t } = useTranslation("tagSettings");
  const name = currentName(tag, lang);
  const preference = tag.namePreferences.find((entry) => entry.lang === lang);
  const defaultName = tag.defaultNames.find((entry) => entry.lang === lang)?.name;
  const aliases = tag.aliases.filter((entry) => entry.lang === null || entry.lang === lang);
  const [draft, setDraft] = useState(name);
  const [alias, setAlias] = useState("");
  useEffect(() => setDraft(name), [name]);
  const desc = [namespaceName(tag.namespace), preference ? t("names.defaultNameOf", { name: defaultName ?? t("names.noName") }) : t("names.defaultName"),
    aliases.length ? t("names.aliasesOf", { aliases: aliases.map((entry) => entry.name).join(t("separator")) }) : ""].filter(Boolean).join(t("names.descSeparator"));
  return <SettingsRow icon={<Tag size={15} />} title={name} hint={desc} label={t("names.rowLabel", { name, state: pending ? t("names.pending") : preference ? t("names.renamed") : t("names.default") })}
    below={open && <div className="k-name-editor" data-catalog-name-id={tag.id}>
      <div className="k-set-inline">
        <input className="k-input" aria-label={t("names.displayName", { name })} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="k-btn is-sm is-primary" disabled={busy || !lang || !draft.trim()} onClick={() => onEdit({ kind: "prefer", name: { lang, name: draft.trim() } })}><span className="k-label">{t("names.saveName")}</span></button>
        <button type="button" className="k-btn is-sm" disabled={busy || !preference} onClick={() => onEdit({ kind: "reset", lang })}><span className="k-label">{t("names.reset")}</span></button>
      </div>
      <p className="k-set-note">{t("names.langDefault", { name: defaultName ?? t("names.noTranslation") })}</p>
      <div className="k-chips" role="list" aria-label={t("names.aliases")}>{aliases.map((entry) => <span role="listitem" key={`${entry.lang}/${entry.name}`} className="k-chip"><span className="k-label">{entry.name}</span>
        <button type="button" className="k-chip-x" disabled={busy} aria-label={t("names.removeAlias", { alias: entry.name })} onClick={() => onEdit({ kind: "removeAlias", alias: entry })}><X size={11} aria-hidden="true" /></button></span>)}</div>
      <div className="k-set-inline">
        <input className="k-input" aria-label={t("names.newAlias", { name })} placeholder={t("names.newAliasPlaceholder")} value={alias} disabled={busy} onChange={(event) => setAlias(event.target.value)} />
        <button type="button" className="k-btn is-sm" disabled={busy || !lang || !alias.trim()} onClick={() => { onEdit({ kind: "addAlias", alias: { name: alias.trim(), lang } }); setAlias(""); }}><span className="k-label">{t("names.addAlias")}</span></button>
      </div>
      {mappings.some((mapping) => mapping.sourceNames?.length) && <ul className="k-list" aria-label={t("names.sourceNames")}>
        {mappings.flatMap((mapping) => (mapping.sourceNames ?? []).map((source) => <li key={`${mapping.libraryId}/${mapping.localTagId}/${source.name}`} className="k-set-inline">
          <span className="k-parts"><span>{source.name}</span><span className="k-set-note">{t("names.from", { library: libraryName(mapping.libraryId) })}</span></span>
          <Select label={t("names.sourceLang", { name: source.name })} value={source.lang} disabled={busy}
            onChange={(next) => onLocal(() => setSourceNameLang(mapping.libraryId, mapping.localTagId, source.name, next))}
            options={[...sourceLanguages(), ...(sourceLanguages().some(([code]) => code === source.lang) ? [] : [[source.lang, source.lang]])].map(([code, label]) => ({ value: code, label }))} />
        </li>))}
      </ul>}
      {tag.external.length === 0 && mappings.length > 0 && <MapExternal name={name} busy={busy}
        onMap={(external) => onLocal(async () => { for (const mapping of mappings) await mapTagExternal(mapping.libraryId, mapping.localTagId, external); })} />}
      <details className="k-more"><summary>{t("details")}</summary><p className="k-parts"><span>{i18n.t(`tags:namespaceOption.${tag.namespace}`)}</span><span>{t("names.id", { id: tag.id })}</span></p><p>{t("names.external", { names: tag.external.map((entry) => `${entry.vocabulary}:${entry.name}`).join(t("separator")) || t("none") })}</p></details>
    </div>}>
    {pending ? <StatusPill tone="accent">{t("names.pending")}</StatusPill> : preference ? <StatusPill tone="mine">{t("names.renamed")}</StatusPill> : <StatusPill>{t("names.default")}</StatusPill>}
    <button type="button" className="k-icon-btn" aria-expanded={open} aria-label={t("names.rename", { name })} title={t("names.renameTitle")} onClick={onToggle}><PenLine size={14} aria-hidden="true" /></button>
  </SettingsRow>;
}

/** 没有外部对应的标签：输入外部名称补上，与迁入向导的补对应相同。 */
function MapExternal({ name, busy, onMap }: { name: string; busy: boolean; onMap: (external: string) => void }) {
  const { t } = useTranslation("tagSettings");
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const change = (text: string) => {
    setDraft(text);
    if (text.trim()) externalSuggestions(text, 8).then((found) => setSuggestions(found ?? []), () => {});
  };
  return <div className="k-set-inline">
    <Combobox label={t("externalLabel", { name })} placeholder={t("externalPlaceholder")} value={draft} disabled={busy} autoHighlight={false}
      options={externalOptions(draft.trim() ? suggestions : [], draft)} onValueChange={change} onSelect={(option) => setDraft(option.id)} />
    <button type="button" className="k-btn is-sm" disabled={busy || !draft.trim()} onClick={() => { onMap(draft.trim()); setDraft(""); }}><span className="k-label">{t("names.map")}</span></button>
  </div>;
}
