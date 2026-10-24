import { SaveDestinationDialog } from "./SaveDestination";
import { workspaceCopySource } from "../ipc";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { WorkspaceSourceTarget } from "../bindings/WorkspaceSourceTarget";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { WorkspaceSourceInspection } from "../bindings/WorkspaceSourceInspection";
import { pinReference, referenceGroups, workspaceSourceGroup, workspaceSourceInspection } from "../ipc";
import { libraryPathHint } from "./library-path";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { SelectionPanel } from "./SelectionPanel";
import { Copy, Layers, Pin } from "lucide-react";
import { useUiScale } from "../shell/uiScale";
import { Select } from "../ui/Select";

/** Adapted from library-workspace.html's explicit source selector, note editor and source actions. */
export function WorkspaceSourceEditor({ card, source, safe, reloadKey, onClose, onChanged, registrations = [] }: {
  card: WorkspaceCard; source: WorkspaceSource; safe: boolean; reloadKey: number; registrations?: LibraryRegistration[];
  onSource: (source: WorkspaceSource) => void; onClose: () => void; onChanged?: () => void;
}) {
  const path = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) => path(id) ? libraryPathHint(path(id)!, registrations.map((r) => r.library.root)) : id;
  const target: WorkspaceSourceTarget = { libraryId: source.libraryId, imageId: source.imageId, contentId: card.id };
  // 整理改了这份来源后重读（#158：详情、标签与文件夹树都出自这一次来源检查）。
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([target, safe, reloadKey, refresh]);
  const current = useRef(key); current.current = key;
  const [ready, setReady] = useState<{ key: string; value: WorkspaceSourceInspection } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const uiScale = useUiScale();
  const [groupId, setGroupId] = useState("");
  const [name, setName] = useState("");
  const [copying,setCopying]=useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setProblem(null); setNotice(null);
    workspaceSourceInspection(target, safe, "zh-CN").then(
      (value) => alive && setReady({ key, value }),
      (error) => { if (alive) { setReady(null); setProblem(String(error)); } },
    );
    return () => { alive = false; };
  }, [key]);
  useEffect(() => {
    let alive = true;
    referenceGroups().then((value) => alive && setGroups(value), () => {});
    return () => { alive = false; };
  }, []);
  // 重读期间留着上一次的内容（不可操作），不让面板闪成“正在读取”。
  const available = ready !== null;
  const run = (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setProblem(null); setNotice(null);
    void action().then(() => { if (current.current === key) setNotice(message); },
      (error) => { if (current.current === key) setProblem(String(error)); })
      // The action's own change often reloads the source before it replies; it still ends this action (#98 native r18).
      .finally(() => setBusy(false));
  };
  return <div className="workspace-source-editor" aria-label="整理来源" title={source.libraryId + "/" + source.imageId}>
    <p className="insp-hint">只整理「{source.libraryName}」的这份来源，其他图库的整理保持独立。</p>
    {path(source.libraryId) && <p className="workspace-source-path" title={path(source.libraryId)}>{hint(source.libraryId)}</p>}
    {problem && <p className="insp-problem" role="alert">{problem}</p>}
    {notice && <p className="insp-notice" role="status">{notice}</p>}
    {!available && !problem && <p className="insp-hint" role="status">正在读取该来源…</p>}
    {available && <>
      <SelectionPanel key={JSON.stringify(target)} sourceTarget={target} libraryId={source.libraryId}
        inspection={{ value: ready.value, stale: ready.key !== key, reload: () => setRefresh((n) => n + 1) }}
        selected={new Set([source.imageId])} scope={{ kind: ready.value.detail.deletedAt !== null ? "trash" : "all" }}
        safeMode={safe} reloadKey={reloadKey} generation={reloadKey} onError={setProblem}
        onClear={onClose} onSourceChanged={onChanged} />
      <fieldset className="insp-use" disabled={busy}><legend>使用此来源</legend>
        <div className="insp-use-row">
          <div className="k-field"><span className="k-field-label">加入哪个参考组</span><Select label="加入哪个参考组" value={groupId} onChange={setGroupId} disabled={busy}
            options={[{ value: "", label: "新建参考组" }, ...groups.filter((g) => !g.problem).map((g) => ({ value: g.id, label: g.name }))]} /></div>
          {!groupId && <label className="k-field"><span className="k-field-label">新参考组名称</span><input className="k-input" aria-label="新参考组名称" value={name} onChange={(event) => setName(event.target.value)} /></label>}
        </div>
        <div className="insp-foot">
          <button type="button" className="k-btn" onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            // 钉图不随界面缩放（#173）：宽 200 个系统缩放下的像素。
            const pinDpr = dpr / uiScale;
            run(() => pinReference(source.libraryId, source.imageId, null, {
              x: Math.round(rect.left * dpr), y: Math.round(rect.top * dpr),
              width: Math.round(200 * pinDpr), height: Math.round(200 * card.height / card.width * pinDpr),
            }), `已钉住「${source.libraryName}」的原图`);
          }}><Pin size={14} aria-hidden="true" /><span className="k-label">钉住</span></button>
          <button type="button" className="k-btn" disabled={!groupId && !name.trim()} onClick={() => run(
            () => workspaceSourceGroup(target, safe, groupId ? { groupId } : { name: name.trim() }),
            `已将「${source.libraryName}」的此来源加入参考组`,
          )}><Layers size={14} aria-hidden="true" /><span className="k-label">加入组</span></button>
          <button type="button" className="k-btn" onClick={()=>setCopying(true)}><Copy size={14} aria-hidden="true" /><span className="k-label">复制到…</span></button>
        </div>
      </fieldset>
    </>}
    {copying&&<SaveDestinationDialog title="复制此来源" confirmLabel="确认复制" onClose={()=>setCopying(false)} onConfirm={async destination=>{
      await workspaceCopySource(target,destination,safe);if(current.current===key){setNotice("已复制此来源，目标已有人工整理保持不变");onChanged?.();}
    }}/>}
  </div>;
}
