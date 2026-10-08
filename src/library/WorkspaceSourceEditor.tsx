import { useEffect, useRef, useState } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import type { GroupSummary } from "../bindings/GroupSummary";
import { pinReference, referenceGroups, workspaceSourceGroup, workspaceSourceInspection } from "../ipc";
import { libraryPathHint } from "./library-path";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { SelectionPanel } from "./SelectionPanel";

/** Adapted from library-workspace.html's explicit source selector, note editor and source actions. */
export function WorkspaceSourceEditor({ card, source, safe, reloadKey, onSource, onClose, onChanged, registrations = [] }: {
  card: WorkspaceCard; source: WorkspaceSource; safe: boolean; reloadKey: number; registrations?: LibraryRegistration[];
  onSource: (source: WorkspaceSource) => void; onClose: () => void; onChanged?: () => void;
}) {
  const path = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) => path(id) ? libraryPathHint(path(id)!, registrations.map((r) => r.library.root)) : id;
  const target: WorkspaceSourceTarget = { libraryId: source.libraryId, imageId: source.imageId, contentId: card.id };
  const key = JSON.stringify([target, safe, reloadKey]);
  const current = useRef(key); current.current = key;
  const [ready, setReady] = useState<{ key: string; deleted: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setProblem(null); setNotice(null);
    workspaceSourceInspection(target, safe, "zh-CN").then(
      (value) => alive && setReady({ key, deleted: value.detail.deletedAt !== null }),
      (error) => alive && setProblem(String(error)),
    );
    return () => { alive = false; };
  }, [key]);
  useEffect(() => {
    let alive = true;
    referenceGroups().then((value) => alive && setGroups(value), () => {});
    return () => { alive = false; };
  }, []);
  const available = ready?.key === key;
  const run = (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setProblem(null); setNotice(null);
    void action().then(() => { if (current.current === key) setNotice(message); },
      (error) => { if (current.current === key) setProblem(String(error)); })
      .finally(() => { if (current.current === key) setBusy(false); });
  };
  return <div className="workspace-source-editor" aria-label="整理来源" title={source.libraryId + "/" + source.imageId}>
    <label>当前操作的来源记录
      <select aria-label="当前操作的来源记录" value={source.libraryId + "/" + source.imageId} onChange={(event) => {
        const next = card.sources.find((s) => s.libraryId + "/" + s.imageId === event.target.value);
        if (next) onSource(next);
      }}>{card.sources.map((s) => <option key={s.libraryId + "/" + s.imageId} value={s.libraryId + "/" + s.imageId} disabled={!!s.unavailable}>
        {s.libraryName} · {hint(s.libraryId)}{s.deleted ? " · 回收站" : ""}{s.unavailable ? " · 暂时不可用" : ""}
      </option>)}</select>
    </label>
    <p>只整理「{source.libraryName}」的这份来源。其他资料库的整理保持独立。</p>
    <p className="workspace-source-path" title={path(source.libraryId)}>{hint(source.libraryId)}</p>
    {problem && <p role="alert">{problem}</p>}
    {notice && <p role="status">{notice}</p>}
    {!available && !problem && <p role="status">正在读取该来源…</p>}
    {available && <>
      <SelectionPanel key={JSON.stringify(target)} sourceTarget={target} libraryId={source.libraryId}
        selected={new Set([source.imageId])} scope={{ kind: ready.deleted ? "trash" : "all" }}
        safeMode={safe} reloadKey={reloadKey} generation={reloadKey} onError={setProblem}
        onClear={onClose} onSourceChanged={onChanged} />
      <fieldset disabled={busy}><legend>使用此来源</legend>
        <button type="button" onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          run(() => pinReference(source.libraryId, source.imageId, null, {
            x: Math.round(rect.left * dpr), y: Math.round(rect.top * dpr),
            width: Math.round(200 * dpr), height: Math.round(200 * card.height / card.width * dpr),
          }), `已钉住「${source.libraryName}」的原图`);
        }}>钉住此来源</button>
        <label>加入哪个参考组<select aria-label="加入哪个参考组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">新建参考组</option>{groups.filter((g) => !g.problem).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></label>
        {!groupId && <label>新参考组名称<input aria-label="新参考组名称" value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <button type="button" disabled={!groupId && !name.trim()} onClick={() => run(
          () => workspaceSourceGroup(target, safe, groupId ? { groupId } : { name: name.trim() }),
          `已将「${source.libraryName}」的此来源加入参考组`,
        )}>加入参考组</button>
      </fieldset>
    </>}
  </div>;
}
