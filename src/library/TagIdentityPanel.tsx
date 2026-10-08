import { useEffect, useRef, useState } from "react";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import type { TagNamespace } from "../bindings/TagNamespace";
import { correctTagMapping, inspectTagCatalog, onSafeModeSetting } from "../ipc";

const namespaces: Record<TagNamespace, string> = { general: "一般", artist: "作者", character: "角色", work: "作品" };
const basis = { independent: "独立身份", external: "外部对应", conflictingExternal: "外部对应有歧义", corrected: "已纠正" };
const nameOf = (tag: CatalogTag) => tag.names.find((n) => n.lang === "zh-CN")?.name ?? tag.names[0]?.name ?? tag.external[0]?.name.replaceAll("_", " ") ?? "未命名标签";
const localName = (mapping: LibraryTagMapping) => mapping.legacy.names.find((n) => n.lang === "zh-CN")?.name ?? mapping.legacy.names[0]?.name ?? mapping.legacy.external[0]?.replaceAll("_", " ") ?? "未命名标签";

/** Settings fieldset and explicit row actions follow the approved reference-browser SettingsDialog. */
export function TagIdentityPanel() {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const unlisten = onSafeModeSetting(() => {
      if (!alive) return;
      generation.current++;
      setWorkspace(null);
      setError(null);
      setBusy(false);
    });
    return () => {
      alive = false;
      generation.current++;
      void unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const run = async (action: () => Promise<TagCatalogWorkspace>) => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try { const next = await action(); if (request === generation.current) setWorkspace(next); }
    catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  return <fieldset aria-label="统一标签目录">
    <legend>统一标签目录</legend>
    <p className="settings-hint">检查不同资料库的标签对应。同名和别名重合的标签保持独立；纠正对应后，各库的人工添加和否决继续独立保存。</p>
    <button type="button" disabled={busy} onClick={() => void run(inspectTagCatalog)}>检查标签对应</button>
    {busy && <p role="status">正在读取标签对应…</p>}
    {error && <p role="alert">{error}</p>}
    {workspace && <>
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} role="status">{library.name}：{unavailable}</p>)}
      {workspace.catalog.mappings.length === 0 ? <p>可用资料库中还没有标签。</p> : <table className="settings-shortcuts">
        <thead><tr><th>资料库与原显示</th><th>统一标签身份</th><th>纠正对应</th></tr></thead>
        <tbody>{workspace.catalog.mappings.map((mapping) => <MappingRow key={`${mapping.libraryId}/${mapping.localTagId}`} mapping={mapping} workspace={workspace} busy={busy} onSave={(catalogId) => void run(() => correctTagMapping(mapping.libraryId, mapping.localTagId, catalogId === "separate" ? { kind: "separate" } : { kind: "use", catalogId }))} />)}</tbody>
      </table>}
    </>}
  </fieldset>;
}

function MappingRow({ mapping, workspace, busy, onSave }: { mapping: LibraryTagMapping; workspace: TagCatalogWorkspace; busy: boolean; onSave: (id: string) => void }) {
  const [target, setTarget] = useState(mapping.catalogId);
  useEffect(() => setTarget(mapping.catalogId), [mapping.catalogId]);
  const library = workspace.libraries.find((entry) => entry.library.id === mapping.libraryId)?.library;
  const shared = workspace.catalog.tags.find((tag) => tag.id === mapping.catalogId);
  const candidates = workspace.catalog.tags.filter((tag) => tag.namespace === mapping.legacy.namespace);
  return <tr data-library-id={mapping.libraryId} data-local-tag-id={mapping.localTagId}>
    <th scope="row"><span>{library?.name ?? mapping.libraryId} · </span><span>{localName(mapping)}</span><small> · {namespaces[mapping.legacy.namespace]}</small>
      <details><summary>本地定义</summary><p>库内 ID：{mapping.localTagId}</p><p>别名：{mapping.legacy.aliases.map((a) => a.name).join("、") || "无"}</p><p>外部对应：{mapping.legacy.external.map((name) => `danbooru:${name}`).join("、") || "无"}</p><p>名称来源待处理：迁移选择前保留原显示。</p></details>
    </th>
    <td><span>{shared ? nameOf(shared) : mapping.catalogId}</span><small> · {basis[mapping.basis]}</small><details><summary>统一定义</summary><p>统一 ID：{mapping.catalogId}</p><p>外部对应：{shared?.external.map((e) => `${e.vocabulary}:${e.name}`).join("、") || "无"}</p></details></td>
    <td><select aria-label={`纠正 ${library?.name ?? mapping.libraryId} 的 ${localName(mapping)} 对应`} value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
      {candidates.map((tag) => <option key={tag.id} value={tag.id}>{nameOf(tag)} · {namespaces[tag.namespace]} · {tag.id.slice(-8)}</option>)}
      <option value="separate">拆成独立标签</option>
    </select><button type="button" disabled={busy || target === mapping.catalogId} onClick={() => onSave(target)}>保存对应</button></td>
  </tr>;
}
