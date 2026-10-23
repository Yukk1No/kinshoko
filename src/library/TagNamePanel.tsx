import { useEffect, useRef, useState } from "react";
import { PenLine, Search, Tag, X } from "lucide-react";
import type { CatalogNameEdit } from "../bindings/CatalogNameEdit";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { editTagName, externalSuggestions, inspectTagCatalog, mapTagExternal, onSafeModeSetting, setSourceNameLang } from "../ipc";
import { SettingsRow, StatusPill } from "../ui/SettingsList";
import { currentName } from "../tags/catalogName";
import { SOURCE_LANGUAGES } from "../tags/languages";
import { Select } from "../ui/Select";
import { Combobox } from "../ui/Combobox";
import { externalOptions } from "./EagleTagStep";

const LIMIT = 80;
const NAMESPACES: Record<string, string> = { general: "", artist: "作者", character: "角色", work: "作品" };

/**
 * 设置 › 标签 › 显示名：显示名先用名称偏好（界面上写“已改名”），没有时用默认名称；改一次在所有图库生效。
 * 别名单独用于查找。每行只标出状态，点“改名”展开一个标签的编辑，一次只编辑一个。
 * 图库带来的来源名称（例如 Eagle 原有标签，#217）在展开后列出，可以改它的语言；
 * “只看没有外部对应的”列出这类标签，展开后可以补上外部对应，或直接改显示名。
 * `focus`：从别处（例如详情面板的改名框，#182）打开时要定位的统一标签，排在最前并展开。
 */
export function TagNamePanel({ focus }: { focus?: string } = {}) {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const [lang, setLang] = useState("zh-CN");
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
  return <section className="tag-names" aria-label="标签显示名" aria-busy={busy}>
    <div className="k-set-toolbar">
      <label className="k-search"><Search size={14} aria-hidden="true" />
        <input aria-label="查找要改名称的标签" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜标签名或别名" /></label>
      <label className="k-check"><input type="checkbox" checked={preferencesOnly} onChange={(event) => setPreferencesOnly(event.target.checked)} />只看改过名的</label>
      <label className="k-check"><input type="checkbox" checked={unmappedOnly} onChange={(event) => setUnmappedOnly(event.target.checked)} />只看没有外部对应的</label>
      <label className="k-lang" title="名称语言">语言<input className="k-input" aria-label="名称语言" value={lang} onChange={(event) => setLang(event.target.value)} placeholder="zh-CN" /></label>
    </div>
    {busy && !workspace && <p className="k-set-note" role="status">正在读取标签…</p>}
    {error && <p className="k-set-error" role="alert">{error}</p>}
    {!workspace && !busy && <button type="button" className="k-btn is-sm" onClick={() => void run(inspectTagCatalog)}>读取标签</button>}
    {workspace && <>
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} className="k-set-note" role="status">{library.name}：{unavailable}</p>)}
      {shown.length === 0 ? <p className="k-set-note">{workspace.catalog.tags.length === 0 ? "图库里还没有标签。" : "没有匹配的标签。"}</p>
        : <ul className="k-list k-set-list" aria-label="标签">
          {shown.map((tag) => <NameRow key={`${tag.id}/${language}`} tag={tag} lang={language} busy={busy} pending={pending.has(tag.id)}
            mappings={workspace.catalog.mappings.filter((mapping) => mapping.catalogId === tag.id)}
            libraryName={(id) => workspace.libraries.find((entry) => entry.library.id === id)?.library.name ?? "图库"}
            open={editing === tag.id} onToggle={() => setEditing(editing === tag.id ? null : tag.id)}
            onEdit={(edit) => void run(() => editTagName(tag.id, edit))}
            onLocal={(action) => void run(async () => { await action(); return inspectTagCatalog(); })} />)}
        </ul>}
      {matches.length > shown.length && <p className="k-set-note">共 {matches.length} 个，先列出 {shown.length} 个。继续输入可以缩小范围。</p>}
    </>}
  </section>;
}

function NameRow({ tag, lang, busy, pending, mappings, libraryName, open, onToggle, onEdit, onLocal }: {
  tag: CatalogTag; lang: string; busy: boolean; pending: boolean; mappings: LibraryTagMapping[]; libraryName: (id: string) => string;
  open: boolean; onToggle: () => void; onEdit: (edit: CatalogNameEdit) => void; onLocal: (action: () => Promise<unknown>) => void;
}) {
  const name = currentName(tag, lang);
  const preference = tag.namePreferences.find((entry) => entry.lang === lang);
  const defaultName = tag.defaultNames.find((entry) => entry.lang === lang)?.name;
  const aliases = tag.aliases.filter((entry) => entry.lang === null || entry.lang === lang);
  const [draft, setDraft] = useState(name);
  const [alias, setAlias] = useState("");
  useEffect(() => setDraft(name), [name]);
  const desc = [NAMESPACES[tag.namespace], preference ? `默认名 ${defaultName ?? "暂无"}` : "默认名称", aliases.length ? `别名 ${aliases.map((entry) => entry.name).join("、")}` : ""].filter(Boolean).join("，");
  return <SettingsRow icon={<Tag size={15} />} title={name} hint={desc} label={`${name}，${pending ? "待确认" : preference ? "已改名" : "默认"}`}
    below={open && <div className="k-name-editor" data-catalog-name-id={tag.id}>
      <div className="k-set-inline">
        <input className="k-input" aria-label={`“${name}”的显示名`} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="k-btn is-sm is-primary" disabled={busy || !lang || !draft.trim()} onClick={() => onEdit({ kind: "prefer", name: { lang, name: draft.trim() } })}>保存显示名</button>
        <button type="button" className="k-btn is-sm" disabled={busy || !preference} onClick={() => onEdit({ kind: "reset", lang })}>恢复默认</button>
      </div>
      <p className="k-set-note">本语言默认：{defaultName ?? "暂无译名"}</p>
      <div className="k-chips" role="list" aria-label="别名">{aliases.map((entry) => <span role="listitem" key={`${entry.lang}/${entry.name}`} className="k-chip">{entry.name}
        <button type="button" className="k-chip-x" disabled={busy} aria-label={`去掉别名“${entry.name}”`} onClick={() => onEdit({ kind: "removeAlias", alias: entry })}><X size={11} aria-hidden="true" /></button></span>)}</div>
      <div className="k-set-inline">
        <input className="k-input" aria-label={`“${name}”的新别名`} placeholder="新别名" value={alias} disabled={busy} onChange={(event) => setAlias(event.target.value)} />
        <button type="button" className="k-btn is-sm" disabled={busy || !lang || !alias.trim()} onClick={() => { onEdit({ kind: "addAlias", alias: { name: alias.trim(), lang } }); setAlias(""); }}>加别名</button>
      </div>
      {mappings.some((mapping) => mapping.sourceNames?.length) && <ul className="k-list" aria-label="来源名称">
        {mappings.flatMap((mapping) => (mapping.sourceNames ?? []).map((source) => <li key={`${mapping.libraryId}/${mapping.localTagId}/${source.name}`} className="k-set-inline">
          <span className="k-parts"><span>{source.name}</span><span className="k-set-note">来自{libraryName(mapping.libraryId)}</span></span>
          <Select label={`“${source.name}”的语言`} value={source.lang} disabled={busy}
            onChange={(next) => onLocal(() => setSourceNameLang(mapping.libraryId, mapping.localTagId, source.name, next))}
            options={[...SOURCE_LANGUAGES, ...(SOURCE_LANGUAGES.some(([code]) => code === source.lang) ? [] : [[source.lang, source.lang]])].map(([code, label]) => ({ value: code, label }))} />
        </li>))}
      </ul>}
      {tag.external.length === 0 && mappings.length > 0 && <MapExternal name={name} busy={busy}
        onMap={(external) => onLocal(async () => { for (const mapping of mappings) await mapTagExternal(mapping.libraryId, mapping.localTagId, external); })} />}
      <details className="k-more"><summary>详情</summary><p className="k-parts"><span>{NAMESPACES[tag.namespace] || "一般"}</span><span>编号 {tag.id}</span></p><p>外部对应：{tag.external.map((entry) => `${entry.vocabulary}:${entry.name}`).join("、") || "无"}</p></details>
    </div>}>
    {pending ? <StatusPill tone="accent">待确认</StatusPill> : preference ? <StatusPill tone="mine">已改名</StatusPill> : <StatusPill>默认</StatusPill>}
    <button type="button" className="k-icon-btn" aria-expanded={open} aria-label={`改名“${name}”`} title="改名" onClick={onToggle}><PenLine size={14} aria-hidden="true" /></button>
  </SettingsRow>;
}

/** 没有外部对应的标签：输入外部名称补上，与迁入向导的补对应相同。 */
function MapExternal({ name, busy, onMap }: { name: string; busy: boolean; onMap: (external: string) => void }) {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const change = (text: string) => {
    setDraft(text);
    if (text.trim()) externalSuggestions(text, 8).then((found) => setSuggestions(found ?? []), () => {});
  };
  return <div className="k-set-inline">
    <Combobox label={`“${name}”的外部对应`} placeholder="外部名称，如 blue_eyes" value={draft} disabled={busy} autoHighlight={false}
      options={externalOptions(draft.trim() ? suggestions : [], draft)} onValueChange={change} onSelect={(option) => setDraft(option.id)} />
    <button type="button" className="k-btn is-sm" disabled={busy || !draft.trim()} onClick={() => { onMap(draft.trim()); setDraft(""); }}>补上外部对应</button>
  </div>;
}
