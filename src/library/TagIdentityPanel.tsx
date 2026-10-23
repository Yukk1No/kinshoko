import { useEffect, useRef, useState } from "react";
import type { CatalogTag } from "../bindings/CatalogTag";
import type { LibraryTagMapping } from "../bindings/LibraryTagMapping";
import type { TagCatalogWorkspace } from "../bindings/TagCatalogWorkspace";
import type { TagNamespace } from "../bindings/TagNamespace";
import { correctTagMapping, inspectTagCatalog, onLibraryEvent, onSafeModeSetting, publishTagDefinitions } from "../ipc";

import { libraryPathHint } from "./library-path";

const namespaces: Record<TagNamespace, string> = { general: "一般", artist: "作者", character: "角色", work: "作品" };
const basis = { independent: "独立", external: "按词表", conflictingExternal: "词表有歧义", corrected: "已纠正" };
const nameOf = (tag: CatalogTag) => tag.names.find((n) => n.lang === "zh-CN")?.name ?? tag.names[0]?.name ?? tag.external[0]?.name.replaceAll("_", " ") ?? "未命名标签";
const localName = (mapping: LibraryTagMapping) => mapping.legacy.names.find((n) => n.lang === "zh-CN")?.name ?? mapping.legacy.names[0]?.name ?? mapping.legacy.external[0]?.replaceAll("_", " ") ?? "未命名标签";

/** Settings fieldset and explicit row actions follow the approved reference-browser SettingsDialog. */
export function TagIdentityPanel() {
  const [workspace, setWorkspace] = useState<TagCatalogWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inspected = useRef(false);
  const running = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    let alive = true;
    const unlisten = onSafeModeSetting(() => {
      if (!alive) return;
      generation.current++;
      inspected.current = false; running.current = false; dirty.current = false;
      setWorkspace(null);
      setError(null); setNotice(null);
      setBusy(false);
    });
    const vocabulary = onLibraryEvent((event) => {
      if (!alive || event.kind !== "vocabularyChanged" || !inspected.current) return;
      if (running.current) dirty.current = true;
      else void run(inspectTagCatalog, undefined, true);
    });
    return () => {
      alive = false;
      inspected.current = false; dirty.current = false;
      generation.current++;
      void unlisten.then((stop) => stop()).catch(() => {});
      void vocabulary.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const run = async (action: () => Promise<TagCatalogWorkspace>, success?: string, automatic = false) => {
    const request = ++generation.current;
    inspected.current = true; running.current = true;
    setBusy(true);
    // Vocabulary refreshes update rows without dismissing an unresolved publication failure.
    if (!automatic) { setError(null); setNotice(null); }
    try { const next = await action(); if (request === generation.current) { setWorkspace(next); if (!automatic) setNotice(success ?? null); } }
    catch (reason) { if (request === generation.current) setError((previous) => automatic && previous !== null ? previous : String(reason)); }
    finally { if (request === generation.current) { setBusy(false); running.current = false; if (dirty.current) { dirty.current = false; void run(inspectTagCatalog, undefined, true); } } }
  };
  return <section className="tag-identity" aria-label="图库间标签对应">
    <p className="k-set-note">同名的标签各自独立。认错了可以在这里纠正，各图库里的人工添加和否决不受影响。</p>
    <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void run(inspectTagCatalog)}>检查标签对应</button>
    {busy && <p role="status">正在读取标签对应…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {workspace && <>
      <p className="settings-hint">带走图库前，先把标签定义存进图库。默认名称、别名与对应随图库携带；改过的显示名留在偏好设置里。只读或离线时可以保留程序中的选择，稍后重试保存。</p>
      {workspace.libraries.map(({library, unavailable}) => <div key={"definitions-" + library.id} className="settings-actions">
        <span className="k-parts" title={library.root}><span>{library.name}</span><span className="k-set-note">{libraryPathHint(library.root, workspace.libraries.map((entry) => entry.library.root))}</span></span>
        <button type="button" className="k-btn is-sm" aria-label={"保存 " + library.name + " 的标签定义"} disabled={busy || Boolean(unavailable)} onClick={() => void run(() => publishTagDefinitions(library.id), "标签定义已保存到图库。")}>存进图库</button>
      </div>)}
      {workspace.libraries.filter((entry) => entry.unavailable).map(({ library, unavailable }) => <p key={library.id} role="status">{library.name}：{unavailable}</p>)}
      {workspace.catalog.mappings.length === 0 ? <p className="k-set-note">图库里还没有标签。</p> : <table className="settings-shortcuts">
        <thead><tr><th>图库与原显示</th><th>对应到</th><th>纠正</th></tr></thead>
        <tbody>{workspace.catalog.mappings.map((mapping) => <MappingRow key={`${mapping.libraryId}/${mapping.localTagId}`} mapping={mapping} workspace={workspace} busy={busy} onSave={(catalogId) => void run(() => correctTagMapping(mapping.libraryId, mapping.localTagId, catalogId === "separate" ? { kind: "separate" } : { kind: "use", catalogId }))} />)}</tbody>
      </table>}
    </>}
  </section>;
}

function MappingRow({ mapping, workspace, busy, onSave }: { mapping: LibraryTagMapping; workspace: TagCatalogWorkspace; busy: boolean; onSave: (id: string) => void }) {
  const [target, setTarget] = useState(mapping.catalogId);
  // 对应变了才跟着重置选择。不用 effect：挂载时的 effect 晚于首次渲染执行，会盖掉在那之前做的选择。
  const [shown, setShown] = useState(mapping.catalogId);
  if (shown !== mapping.catalogId) { setShown(mapping.catalogId); setTarget(mapping.catalogId); }
  const library = workspace.libraries.find((entry) => entry.library.id === mapping.libraryId)?.library;
  const shared = workspace.catalog.tags.find((tag) => tag.id === mapping.catalogId);
  const candidates = workspace.catalog.tags.filter((tag) => tag.namespace === mapping.legacy.namespace);
  // 同名候选按出现顺序编号区分，不显示内部编号。
  const seen = new Map<string, number>();
  const choices = candidates.map((tag) => {
    const name = nameOf(tag), n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { tag, label: `${name}（${namespaces[tag.namespace]}）${candidates.filter((other) => nameOf(other) === name).length > 1 ? `（${n}）` : ""}` };
  });
  return <tr data-library-id={mapping.libraryId} data-local-tag-id={mapping.localTagId}>
    <th scope="row"><span className="k-parts"><span>{library?.name ?? "未打开的图库"}</span><span>{localName(mapping)}</span><small>{namespaces[mapping.legacy.namespace]}</small></span>
      <p className="k-set-note">{mapping.nameProvenance === "pending" ? "旧名称待确认，确认前照旧显示。" : `别名：${mapping.legacy.aliases.map((a) => a.name).join("、") || "无"}`}</p>
      <details><summary>详情</summary><p>库内编号：{mapping.localTagId}</p><p>外部对应：{mapping.legacy.external.map((name) => `danbooru:${name}`).join("、") || "无"}</p></details>
    </th>
    <td><span className="k-parts"><span>{shared ? nameOf(shared) : "未命名标签"}</span><small>{basis[mapping.basis]}</small></span><details><summary>详情</summary><p>编号：{mapping.catalogId}</p><p>外部对应：{shared?.external.map((e) => `${e.vocabulary}:${e.name}`).join("、") || "无"}</p></details></td>
    <td><select aria-label={`纠正 ${library?.name ?? "未打开的图库"} 的 ${localName(mapping)} 对应`} value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
      {choices.map(({ tag, label }) => <option key={tag.id} value={tag.id}>{label}</option>)}
      <option value="separate">拆成独立标签</option>
    </select><button type="button" className="k-btn is-sm" disabled={busy || target === mapping.catalogId} onClick={() => onSave(target)}>保存对应</button></td>
  </tr>;
}
