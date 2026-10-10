import { useEffect, useRef, useState } from "react";
import { PenLine, Search, Tag, X } from "lucide-react";
import type { CatalogNameEdit } from "../bindings/CatalogNameEdit";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { editTagName, inspectTagCatalog, onSafeModeSetting } from "../ipc";
import { SettingsRow, StatusPill } from "../ui/SettingsList";

const LIMIT = 80;
const NAMESPACES: Record<string, string> = { general: "", artist: "作者", character: "角色", work: "作品" };
const currentName = (tag: CatalogTag, lang: string) => tag.names.find((name) => name.lang === lang)?.name ?? tag.names[0]?.name ?? tag.external[0]?.name.replaceAll("_", " ") ?? "未命名标签";

/**
 * 设置 › 标签 › 显示名：显示名先用“我的叫法”（显式偏好），没有时用默认名；改一次在所有图库生效。
 * 别名单独用于查找。每行只标出状态，点“改名”展开一个标签的编辑，一次只编辑一个。
 */
export function TagNamePanel() {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const [lang, setLang] = useState("zh-CN");
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [preferencesOnly, setPreferencesOnly] = useState(false);
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
    && [currentName(tag, language), ...tag.names.map((entry) => entry.name), ...tag.aliases.map((entry) => entry.name), ...tag.external.map((entry) => entry.name)]
      .some((name) => name.toLocaleLowerCase().includes(needle))) ?? [];
  const shown = matches.slice(0, LIMIT);
  return <section className="tag-names" aria-label="标签显示名" aria-busy={busy}>
    <div className="k-set-toolbar">
      <label className="k-search"><Search size={14} aria-hidden="true" />
        <input aria-label="查找要改名称的标签" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜标签名或别名" /></label>
      <label className="k-check"><input type="checkbox" checked={preferencesOnly} onChange={(event) => setPreferencesOnly(event.target.checked)} />只看我的叫法</label>
      <label className="k-lang" title="名称语言">语言<input aria-label="名称语言" value={lang} onChange={(event) => setLang(event.target.value)} placeholder="zh-CN" /></label>
    </div>
    {busy && !workspace && <p className="k-set-note" role="status">正在读取标签…</p>}
    {error && <p className="k-set-error" role="alert">{error}</p>}
    {!workspace && !busy && <button type="button" className="k-btn is-sm" onClick={() => void run(inspectTagCatalog)}>读取标签</button>}
    {workspace && <>
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} className="k-set-note" role="status">{library.name}：{unavailable}</p>)}
      {shown.length === 0 ? <p className="k-set-note">{workspace.catalog.tags.length === 0 ? "图库里还没有标签。" : "没有匹配的标签。"}</p>
        : <ul className="k-list k-set-list" aria-label="标签">
          {shown.map((tag) => <NameRow key={`${tag.id}/${language}`} tag={tag} lang={language} busy={busy} pending={pending.has(tag.id)}
            open={editing === tag.id} onToggle={() => setEditing(editing === tag.id ? null : tag.id)}
            onEdit={(edit) => void run(() => editTagName(tag.id, edit))} />)}
        </ul>}
      {matches.length > shown.length && <p className="k-set-note">共 {matches.length} 个，先列出 {shown.length} 个。继续输入可以缩小范围。</p>}
    </>}
  </section>;
}

function NameRow({ tag, lang, busy, pending, open, onToggle, onEdit }: {
  tag: CatalogTag; lang: string; busy: boolean; pending: boolean; open: boolean; onToggle: () => void; onEdit: (edit: CatalogNameEdit) => void;
}) {
  const name = currentName(tag, lang);
  const preference = tag.namePreferences.find((entry) => entry.lang === lang);
  const defaultName = tag.defaultNames.find((entry) => entry.lang === lang)?.name;
  const aliases = tag.aliases.filter((entry) => entry.lang === null || entry.lang === lang);
  const [draft, setDraft] = useState(name);
  const [alias, setAlias] = useState("");
  useEffect(() => setDraft(name), [name]);
  const desc = [NAMESPACES[tag.namespace], preference ? `默认名 ${defaultName ?? "暂无"}` : "默认名称", aliases.length ? `别名 ${aliases.map((entry) => entry.name).join("、")}` : ""].filter(Boolean).join(" · ");
  return <SettingsRow icon={<Tag size={15} />} title={name} desc={desc} label={`${name} · ${pending ? "待确认" : preference ? "我的叫法" : "默认"}`}
    below={open && <div className="k-name-editor" data-catalog-name-id={tag.id}>
      <div className="k-set-inline">
        <input className="k-input" aria-label={`“${name}”的我的叫法`} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        <button type="button" className="k-btn is-sm is-primary" disabled={busy || !lang || !draft.trim()} onClick={() => onEdit({ kind: "prefer", name: { lang, name: draft.trim() } })}>记为我的叫法</button>
        <button type="button" className="k-btn is-sm" disabled={busy || !preference} onClick={() => onEdit({ kind: "reset", lang })}>恢复默认</button>
      </div>
      <p className="k-set-note">本语言默认：{defaultName ?? "暂无译名"}</p>
      <div className="k-chips" role="list" aria-label="别名">{aliases.map((entry) => <span role="listitem" key={`${entry.lang}/${entry.name}`} className="k-chip">{entry.name}
        <button type="button" className="k-chip-x" disabled={busy} aria-label={`去掉别名“${entry.name}”`} onClick={() => onEdit({ kind: "removeAlias", alias: entry })}><X size={11} aria-hidden="true" /></button></span>)}</div>
      <div className="k-set-inline">
        <input className="k-input" aria-label={`“${name}”的新别名`} placeholder="新别名" value={alias} disabled={busy} onChange={(event) => setAlias(event.target.value)} />
        <button type="button" className="k-btn is-sm" disabled={busy || !lang || !alias.trim()} onClick={() => { onEdit({ kind: "addAlias", alias: { name: alias.trim(), lang } }); setAlias(""); }}>加别名</button>
      </div>
      <details className="k-more"><summary>详情</summary><p>{NAMESPACES[tag.namespace] || "一般"} · 编号 {tag.id}</p><p>外部对应：{tag.external.map((entry) => `${entry.vocabulary}:${entry.name}`).join("、") || "无"}</p></details>
    </div>}>
    {pending ? <StatusPill tone="accent">待确认</StatusPill> : preference ? <StatusPill tone="mine">我的叫法</StatusPill> : <StatusPill>默认</StatusPill>}
    <button type="button" className="k-icon-btn" aria-expanded={open} aria-label={`改名“${name}”`} title="改名" onClick={onToggle}><PenLine size={14} aria-hidden="true" /></button>
  </SettingsRow>;
}
