import { useEffect, useRef, useState } from "react";
import type { LegacyNameGroup } from "../bindings/LegacyNameGroup";
import type { LegacyNameMigrationWorkspace } from "../bindings/LegacyNameMigrationWorkspace";
import type { LegacyNameMigrationPreview } from "../bindings/LegacyNameMigrationPreview";
import type { LegacyNameResolution } from "../bindings/LegacyNameResolution";
import { confirmLegacyNames, onLibraryEvent, onSafeModeSetting, planLegacyNames, previewLegacyNames } from "../ipc";

const key = (group: LegacyNameGroup) => `${group.catalogId}/${group.lang}`;
function choice(group: LegacyNameGroup, value: string): LegacyNameResolution {
  if (value === "default") return { kind: "followDefault" };
  if (value === "preference") return { kind: "keepPreference" };
  const source = group.sources[Number(value.slice(7))];
  return { kind: "keepLegacy", libraryId: source.libraryId, localTagId: source.localTagId };
}
function result(group: LegacyNameGroup, value: string) {
  if (value === "default") return `${group.existingPreference ? `将撤回“${group.existingPreference}”的全局偏好，` : ""}跟随默认“${group.defaultName ?? "本语言无默认译名，将按其他语言回退；完整结果见下方预览"}”。以后随默认更新。`;
  if (value === "preference") return `继续使用已有全局偏好“${group.existingPreference}”。`;
  if (value.startsWith("legacy:")) return `保存全局偏好“${group.sources[Number(value.slice(7))].legacyName}”。即使与默认相同，也保留显式选择。`;
  return "尚未选择名称归属。";
}

/** Adapted from spec78-alignment/tag-name-model.html's legacy source table, explicit choice,
 * and resulting preference/aliases, within the approved SettingsDialog fieldset structure. */
export function LegacyNameMigrationPanel({ openRequest = 0 }: { openRequest?: number }) {
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
  useEffect(() => {
    let alive = true;
    const stop = onSafeModeSetting(() => {
      if (!alive) return;
      generation.current++;
      setView(null); setSelected({}); setError(null); setSaved(false); setBusy(false);
    });
    return () => { alive = false; generation.current++; void stop.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  async function run(action: () => Promise<LegacyNameMigrationWorkspace>, confirming = false) {
    const request = ++generation.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      const next = await action();
      if (request !== generation.current) return;
      setView(next); setSaved(confirming); setSelected({}); setPage(0);
    } catch (reason) { if (request === generation.current) setError(String(reason)); }
    finally { if (request === generation.current) setBusy(false); }
  }
  useEffect(() => { if (openRequest > 0) void run(planLegacyNames); }, [openRequest]);
  function cancel() { generation.current++; setView(null); setSelected({}); setPage(0); setError(null); setSaved(false); setBusy(false); }
  const groups = view?.plan.groups ?? [];
  const group = groups[page];
  const libraryNames = new Map(view?.libraries.map((entry) => [entry.library.id, entry.library.name]));
  const libraryName = (id: string) => libraryNames.get(id) ?? id;
  const value = group ? selected[key(group)] ?? "" : "";
  const chosen = groups.filter((entry) => selected[key(entry)]).length;
  const decisions = chosen === groups.length ? groups.map((entry) => ({ catalogId: entry.catalogId, lang: entry.lang, resolution: choice(entry, selected[key(entry)]) })) : [];
  const choiceKey = chosen === groups.length ? JSON.stringify(decisions) : "";
  const validPreview = preview !== null && previewChoiceKey === choiceKey && preview.revision === view?.plan.revision;
  const bulkEligible = groups.filter((entry) => !selected[key(entry)] && entry.existingPreference === null && new Set(entry.sources.map((source) => source.legacyName)).size === 1);
  function bulkFollow() {
    const next = { ...selected };
    for (const entry of bulkEligible) next[key(entry)] = "default";
    setSelected(next);
  }
  useEffect(() => {
    let alive = true;
    const request = generation.current;
    setPreview(null); setPreviewChoiceKey(""); setPreviewPage(0); setPreviewBusy(false);
    if (!view || groups.length === 0 || chosen !== groups.length) return;
    setPreviewBusy(true);
    void previewLegacyNames(view.plan.revision, decisions).then((next) => {
      if (alive && request === generation.current) { setPreview(next); setPreviewChoiceKey(choiceKey); }
    }).catch((reason) => { if (alive && request === generation.current) setError(String(reason)); }).finally(() => { if (alive && request === generation.current) setPreviewBusy(false); });
    return () => { alive = false; };
  }, [view, selected]);
  return <fieldset className="legacy-name-migration" aria-label="旧资料库名称迁移">
    <legend>旧资料库名称迁移</legend>
    <p className="settings-hint">旧名称缺少来源记录。选择前保留旧显示；已有显式偏好继续优先。每个统一标签和语言只选一条全局规则，后接入的旧库仍须确认。取消会放弃本次草稿。</p>
    <button type="button" disabled={busy} onClick={() => void run(planLegacyNames)}>{view ? "重新读取迁移记录" : "迁移旧库名称"}</button>
    {busy && <p role="status">正在读取或保存名称归属…</p>}
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">本批次名称归属已保存。</p>}
    {view && <>
      {view.libraries.filter((entry) => entry.unavailable).map((entry) => <p key={entry.library.id} role="status">{entry.library.name}：{entry.unavailable}。重新连接并打开后可检查旧名称。</p>)}
      {groups.length === 0 && <p>可用资料库中没有待确认的旧名称。</p>}
      {group && <>
        <p role="status">第 {page + 1} / {groups.length} 项 · 已选择 {chosen} / {groups.length}</p>
        <p className="settings-actions"><button type="button" disabled={busy || bulkEligible.length === 0} onClick={bulkFollow}>未选无冲突项跟随默认（{bulkEligible.length}）</button><button type="button" disabled={busy || chosen === groups.length} onClick={() => { const next = groups.findIndex((entry) => !selected[key(entry)]); if (next >= 0) setPage(next); }}>下一待选项</button></p>
        <p className="settings-hint">批量选择只处理没有既有偏好、没有不同旧文字且尚未选择的名称。冲突项须逐项决定，已有选择保持原样。</p>
        <details><summary>统一标签对应</summary><p>{group.namespace} · {group.catalogId} · {group.lang}</p></details>
        <p>名称语言：{group.lang}</p>
        <p>本语言默认：{group.defaultName ?? "本语言无默认译名，将按其他语言回退；完整结果见下方预览"}</p>
        <p>已有全局偏好：{group.existingPreference ?? "无"}</p>
        {new Set(group.sources.map((source) => source.legacyName)).size > 1 && <p className="settings-problem">同一统一标签存在不同旧名称，请明确选择。</p>}
        {group.existingPreference !== null && group.sources.some((source) => source.legacyName !== group.existingPreference) && <p className="settings-problem">旧文字与已有全局偏好不同。确认前请核对下面的全局结果。</p>}
        <table className="settings-shortcuts"><thead><tr><th>旧记录来源</th><th>旧文字</th><th>当前显示</th><th>名称来源</th></tr></thead><tbody>
          {group.sources.map((source) => <tr key={`${source.libraryId}/${source.localTagId}`}><th scope="row">{libraryName(source.libraryId)}<small> · {source.localTagId}</small></th><td>{source.legacyName}</td><td>{source.currentName}</td><td>待确认</td></tr>)}
        </tbody></table>
        <label className="settings-row">名称归属<select aria-label="名称归属" value={value} disabled={busy} onChange={(event) => setSelected({ ...selected, [key(group)]: event.target.value })}>
          <option value="">请选择…</option>
          <option value="default">跟随默认：{group.defaultName ?? "尚无译名"}</option>
          {group.sources.map((source, index) => <option key={`${source.libraryId}/${source.localTagId}`} value={`legacy:${index}`}>保留为全局偏好：{source.legacyName}（{libraryName(source.libraryId)}）</option>)}
          {group.existingPreference !== null && <option value="preference">保留已有全局偏好：{group.existingPreference}</option>}
        </select></label>
        <p aria-live="polite">{result(group, value)}</p>
        <p className="settings-hint">影响的资料库：{group.affectedLibraries.map(libraryName).join("、")}；以后对应到这个身份的资料库也采用共享规则。其他语言的已有偏好保持独立。旧文字保留为可删除的其他叫法。</p>
        <p className="settings-actions"><button type="button" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>上一项</button><button type="button" disabled={busy || page === groups.length - 1} onClick={() => setPage(page + 1)}>下一项</button></p>
        {previewBusy && <p role="status">正在核对本批次最终显示…</p>}
        {validPreview && <><p role="status">最终预览 {previewPage * 20 + 1}–{Math.min((previewPage + 1) * 20, preview!.outcomes.length)} / {preview!.outcomes.length} 项</p><table className="settings-shortcuts" aria-label="迁移后最终显示"><thead><tr><th>标签与语言</th><th>最终显示</th><th>偏好记录</th></tr></thead><tbody>{preview!.outcomes.slice(previewPage * 20, (previewPage + 1) * 20).map((outcome) => <tr key={`${outcome.catalogId}/${outcome.lang}`}><td>{outcome.catalogId.slice(-8)} / {outcome.lang}</td><td>{outcome.displayName}</td><td>{outcome.preferenceName ?? "无；跟随默认"}</td></tr>)}</tbody></table><p className="settings-actions"><button type="button" disabled={busy || previewPage === 0} onClick={() => setPreviewPage(previewPage - 1)}>上一页预览</button><button type="button" disabled={busy || (previewPage + 1) * 20 >= preview!.outcomes.length} onClick={() => setPreviewPage(previewPage + 1)}>下一页预览</button></p></>}
        <p className="settings-actions"><button type="button" disabled={busy || !validPreview} onClick={() => void run(() => confirmLegacyNames(view.plan.revision, decisions), true)}>确认本批次名称归属</button><button type="button" disabled={busy} onClick={cancel}>取消迁移</button></p>
      </>}
    </>}
  </fieldset>;
}

/** Opening a legacy provider keeps its existing display while offering the explicit wizard. */
export function LegacyNameMigrationNotice({ libraryId, safe, onOpen }: { libraryId: string; safe: boolean; onOpen: () => void }) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    setPending(false);
    const read = () => {
      const request = ++generation;
      void planLegacyNames().then((view) => {
        if (alive && request === generation) setPending(view?.plan.groups.some((group) => group.sources.some((source) => source.libraryId === libraryId)) ?? false);
      }).catch(() => {});
    };
    read();
    const unlisten = onLibraryEvent((event) => { if (event.kind === "vocabularyChanged" || event.kind === "taskFinished") read(); });
    const safeStop = onSafeModeSetting(() => { generation++; setPending(false); });
    return () => { alive = false; generation++; void unlisten.then((stop) => stop()).catch(() => {}); void safeStop.then((stop) => stop()).catch(() => {}); };
  }, [libraryId, safe]);
  return pending ? <p className="legacy-name-notice" role="status">这份旧资料库有名称来源待确认。<button type="button" onClick={onOpen}>查看旧名称迁移</button></p> : null;
}
