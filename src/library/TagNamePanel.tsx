import { useEffect, useRef, useState } from "react";
import type { CatalogNameEdit } from "../bindings/CatalogNameEdit";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import { editTagName, inspectTagCatalog, onSafeModeSetting } from "../ipc";

const currentName = (tag: CatalogTag, lang: string) => tag.names.find((name) => name.lang === lang)?.name ?? tag.names[0]?.name ?? tag.external[0]?.name.replaceAll("_", " ") ?? "未命名标签";

/** Adapted from the approved name-model's separate display/default/preference/other-name rows
 * and the reference-browser SettingsDialog fieldset with explicit action buttons. */
export function TagNamePanel() {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const [lang, setLang] = useState("zh-CN");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState("");
  const [preferencesOnly, setPreferencesOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const unlisten = onSafeModeSetting(() => {
      if (!alive) return;
      generation.current++;
      setWorkspace(null); setError(null); setBusy(false);
    });
    return () => { alive = false; generation.current++; void unlisten.then((stop) => stop()).catch(() => {}); };
  }, []);
  const run = async (action: () => Promise<TagCatalogWorkspace>) => {
    const request = ++generation.current;
    setBusy(true); setError(null);
    try { const result = await action(); if (request === generation.current) setWorkspace(result); }
    catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  const matches = workspace?.catalog.tags.filter((tag) => (!preferencesOnly || tag.namePreferences.some((entry) => entry.lang === lang.trim())) && [...tag.names, ...tag.aliases].some((entry) => entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))) ?? [];
  const options = matches.slice(0, 80);
  const selectedTag = options.find((tag) => tag.id === selected) ?? options[0];
  return <fieldset aria-label="标签显示名称">
    <legend>标签显示名称</legend>
    <p className="settings-hint">显示名称先用显式偏好，没有偏好时跟随默认。保存偏好会在各资料库生效；恢复默认撤回该语言的偏好。其他叫法单独用于查找。</p>
    <button type="button" disabled={busy} onClick={() => void run(inspectTagCatalog)}>管理显示名称</button>
    <label className="settings-row">名称语言<input aria-label="名称语言" value={lang} onChange={(event) => setLang(event.target.value)} placeholder="zh-CN" /></label>
    {busy && <p role="status">正在保存或读取名称…</p>}
    {error && <p role="alert">{error}</p>}
    {workspace && <>
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} role="status">{library.name}：{unavailable}</p>)}
      {workspace.catalog.mappings.some((mapping) => mapping.nameProvenance === "pending") && <p className="settings-hint">旧资料库的名称来源待处理。尚未选择名称规则时保留原显示；在这里保存显式偏好，会为该统一标签选择共享名称规则。</p>}
      <label className="settings-row">查找标签<input aria-label="查找要改名称的标签" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="名称或其他叫法" /></label>
      <label className="settings-row"><input type="checkbox" checked={preferencesOnly} onChange={(event) => setPreferencesOnly(event.target.checked)} />只看本语言已保存的偏好</label>
      <label className="settings-row">选择标签<select aria-label="选择标签" value={selectedTag?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>
        {options.map((tag) => <option key={tag.id} value={tag.id}>{currentName(tag, lang.trim())} · {tag.namespace} · {tag.id.slice(-8)}</option>)}
      </select></label>
      {matches.length > options.length && <p className="settings-hint">共有 {matches.length} 个匹配，先列出 {options.length} 个。继续输入可以缩小范围。</p>}
      {!selectedTag ? <p>{workspace.catalog.tags.length === 0 ? "可用资料库中还没有标签。" : "没有匹配的标签。"}</p> : <table className="settings-shortcuts">
        <thead><tr><th>标签与显示名称</th><th>名称偏好</th><th>其他叫法</th></tr></thead>
        <tbody><NameRow key={`${selectedTag.id}/${lang}`} tag={selectedTag} lang={lang.trim()} busy={busy} onEdit={(edit) => void run(() => editTagName(selectedTag.id, edit))} /></tbody>
      </table>}
    </>}
  </fieldset>;
}

function NameRow({ tag, lang, busy, onEdit }: { tag: CatalogTag; lang: string; busy: boolean; onEdit: (edit: CatalogNameEdit) => void }) {
  const name = currentName(tag, lang);
  const preference = tag.namePreferences.find((entry) => entry.lang === lang);
  const defaultName = tag.defaultNames.find((entry) => entry.lang === lang)?.name;
  const [draft, setDraft] = useState(name);
  const [alias, setAlias] = useState("");
  useEffect(() => setDraft(name), [name]);
  return <tr data-catalog-name-id={tag.id}>
    <th scope="row"><span>{name}</span><small> · {preference ? "显式偏好" : "默认名称"}</small>
      <p className="settings-hint">本语言默认：{defaultName ?? "尚无译名"}</p>
      <details><summary>标签身份</summary><p>{tag.namespace} · {tag.id}</p><p>外部对应：{tag.external.map((entry) => `${entry.vocabulary}:${entry.name}`).join("、") || "无"}</p></details>
    </th>
    <td><input aria-label={`“${name}”的偏好名称`} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" disabled={busy || !lang || !draft.trim()} onClick={() => onEdit({ kind: "prefer", name: { lang, name: draft.trim() } })}>保存偏好</button>
      <button type="button" disabled={busy || !preference} onClick={() => onEdit({ kind: "reset", lang })}>恢复默认</button>
    </td>
    <td><ul>{tag.aliases.filter((entry) => entry.lang === null || entry.lang === lang).map((entry) => <li key={`${entry.lang}/${entry.name}`}><span>{entry.name}</span><button type="button" disabled={busy} aria-label={`去掉别名“${entry.name}”`} onClick={() => onEdit({ kind: "removeAlias", alias: entry })}>×</button></li>)}</ul>
      <input aria-label={`“${name}”的新别名`} value={alias} disabled={busy} onChange={(event) => setAlias(event.target.value)} />
      <button type="button" disabled={busy || !lang || !alias.trim()} onClick={() => { onEdit({ kind: "addAlias", alias: { name: alias.trim(), lang } }); setAlias(""); }}>加别名</button>
    </td>
  </tr>;
}
