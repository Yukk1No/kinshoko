import { SaveDestinationDialog, useSaveDestination, folderChoices, destinationAvailable, destinationLabel } from "../library/SaveDestination";
import { useCallback, useEffect, useState } from "react";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { CaptureChoice } from "../bindings/CaptureChoice";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import {
  captureUrl,
  deleteReferenceGroup,
  exportReferenceGroupPackage,
  importReferenceGroupPackage,
  groupSaveCaptures,
  onReferenceGroupsChanged,
  openReferenceGroup,
  referenceGroup,
  referenceGroups,
  registeredLibraries,
  removeGroupMember,
  renameReferenceGroup,
  savePinsToGroup,
  saveReferenceGroup,
} from "../ipc";

type SaveTarget = { name: string } | { groupId: string };
type CaptureSave = { target: SaveTarget; entries: CaptureEntry[]; choices: Record<string, string>; folders:Record<string,string|null> };

function memberState(status: MemberStatus): string {
  switch (status.state.kind) {
    case "available":
      return status.state.sealed ? "安全模式下原位遮蔽" : "可用";
    case "unavailable":
      return status.state.message;
  }
}

/**
 * 参考组（#66）：把桌面上的资料库钉图存成参考组，打开参考组把成员按原来的局部与摆放钉回桌面。
 * 参考组独立于资料库保存，成员可来自多个资料库；资料库不可用、图已删除的成员保留布局并写出原因，
 * 安全模式下被封印的成员在钉图上原位遮蔽。
 *
 * 参考组包（#68）：导出时带上所用原图与整理信息快照，可带到别的电脑；导入时原图进当前资料库
 * （`libraryId`），另存为新的参考组。
 */
export function ReferenceGroupsPanel({}: { libraryId?: string | null }) {
  const saveContext=useSaveDestination();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [libraryOptions, setLibraryOptions] = useState<LibraryRegistration[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReferenceGroupView | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [captureSave, setCaptureSave] = useState<CaptureSave | null>(null);
  const [importing,setImporting]=useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    referenceGroups()
      .then(setGroups)
      .catch((e) => setError(String(e)));
    registeredLibraries()
      .then((list) => {
        setLibraryNames(new Map(list.map((r) => [r.library.id, r.library.name])));
        setLibraryOptions(list);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const unlisten = onReferenceGroupsChanged(reload);
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [reload]);

  // 展开的参考组变了（存回、移出成员）时重新核对成员。
  useEffect(() => {
    if (!expanded || !groups) return;
    const current = groups.find((g) => g.id === expanded.group.id);
    if (!current || current.problem) setExpanded(null);
    else if (current.updatedAt !== expanded.group.updatedAt)
      referenceGroup(current.id).then(setExpanded, () => setExpanded(null));
  }, [groups, expanded]);

  const run = async (action: () => Promise<unknown>, done?: (value: unknown) => string | null) => {
    setError(null);
    setNotice(null);
    try {
      const value = await action();
      if (done) setNotice(done(value) ?? null);
    } catch (e) {
      setError(String(e));
    }
  };

  const libraries = (ids: string[]) => ids.map((id) => libraryNames.get(id) ?? "未登记的资料库").join("、");

  const toggleMembers = (id: string) =>
    expanded?.group.id === id ? setExpanded(null) : void run(() => referenceGroup(id).then(setExpanded));

  const save = async (target: SaveTarget, choices: CaptureChoice[]) => {
    if ("name" in target) {
      if (choices.length) await saveReferenceGroup(target.name, choices);
      else await saveReferenceGroup(target.name);
      setName("");
      setNotice("已把桌面钉图存为参考组");
    } else {
      if (choices.length) await savePinsToGroup(target.groupId, choices);
      else await savePinsToGroup(target.groupId);
      setNotice("已把桌面钉图存进这个参考组");
    }
    setCaptureSave(null);
  };
  const beginSave = async (target: SaveTarget) => {
    setSaving(true);
    try {
      const entries = await groupSaveCaptures();
      if (!entries.length) { await save(target, []); return; }
      const choices: Record<string, string> = {};
      for (const entry of entries) {
        const collected = entry.collected.length === 1 ? entry.collected[0] : null;
        choices[entry.id] = collected && libraryOptions.some((l) => l.library.id === collected.libraryId && !l.unavailable)
          ? collected.libraryId : "";
      }
      setCaptureSave({ target, entries, choices, folders:{} });
    } finally { setSaving(false); }
  };
  const confirmCaptures = async () => {
    if (!captureSave) return;
    setSaving(true);
    try {
      await run(() => save(captureSave.target, captureSave.entries.map((entry) => ({
        captureId: entry.id,
        libraryId: captureSave.choices[entry.id] === "skip" ? null : captureSave.choices[entry.id],
        folderId: captureSave.folders[entry.id]??null,
      }))));
    } finally { setSaving(false); }
  };

  return (
    <section className="reference-groups" aria-label="参考组">
      <header className="reference-groups-bar">
        <h2>参考组</h2>
        <input
          aria-label="新参考组名称"
          placeholder="名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          disabled={!name.trim() || !!captureSave || saving}
          onClick={() => void run(() => beginSave({ name }))}
        >
          把桌面钉图存为参考组
        </button>
        <button type="button" onClick={()=>setImporting(true)}>导入参考组包</button>
      </header>
      {importing&&<SaveDestinationDialog title="导入参考组包" confirmLabel="选择参考组包并导入" onClose={()=>setImporting(false)} onConfirm={async destination=>{
        const group=await importReferenceGroupPackage(destination.libraryId,destination);
        if(group)setNotice(`已导入参考组「${group.name}」，原图保存到所选资料库和目录`);
      }}/>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {captureSave && (
        <section role="dialog" aria-modal="true" aria-label="收藏截图并保存参考组" className="capture-group-save">
          <p>逐张选择截图的资料库和文件夹，收藏后一起加入参考组。也可以明确不加入这张截图。</p>
          {captureSave.entries.map((entry, i) => (
            <label key={entry.id}>
              <img src={captureUrl(entry.id)} alt={`截图 ${i + 1}`} width={96} />
              <span>截图 {i + 1} · {entry.width}×{entry.height}</span>
              <select aria-label={`截图 ${i + 1} 的资料库`} disabled={saving}
                value={captureSave.choices[entry.id]}
                onChange={(e) => setCaptureSave({ ...captureSave, choices: { ...captureSave.choices, [entry.id]: e.target.value }, folders:{...captureSave.folders,[entry.id]:null} })}>
                <option value="">请选择资料库…</option>
                {libraryOptions.map((option) => (
                  <option key={option.library.id} value={option.library.id} disabled={!!option.unavailable}>
                    {option.library.name}{option.unavailable ? "（暂时不可用）" : entry.collected.some((c) => c.libraryId === option.library.id) ? "（已收藏）" : ""}
                  </option>
                ))}
                <option value="skip">不加入参考组</option>
              </select>
              {captureSave.choices[entry.id]&&captureSave.choices[entry.id]!=="skip"&&<>
                <span>文件夹</span><select aria-label={`截图 ${i+1} 的文件夹`} disabled={saving} value={captureSave.folders[entry.id]??""} onChange={event=>setCaptureSave({...captureSave,folders:{...captureSave.folders,[entry.id]:event.target.value||null}})}>
                  <option value="">未归类</option>
                  {folderChoices(saveContext.providers.find(p=>p.registration.library.id===captureSave.choices[entry.id])?.sidebar?.folders??[]).map(folder=><option key={folder.id} value={folder.id}>{folder.path}</option>)}
                </select>
                <span>最终位置：{destinationLabel({libraryId:captureSave.choices[entry.id],folderId:captureSave.folders[entry.id]??null},saveContext.providers)}</span>
              </>}
            </label>
          ))}
          <button type="button" disabled={saving || !saveContext.ready || captureSave.entries.some((e) => captureSave.choices[e.id]!=="skip"&&!destinationAvailable({libraryId:captureSave.choices[e.id],folderId:captureSave.folders[e.id]??null},saveContext.providers))}
            onClick={() => void confirmCaptures()}>{saving ? "正在收藏并保存…" : "确认并保存"}</button>
          <button type="button" disabled={saving} onClick={() => setCaptureSave(null)}>取消</button>
        </section>
      )}
      {groups && groups.length === 0 && (
        <p className="reference-groups-empty">
          还没有参考组。把整图或局部钉到桌面、摆好，再在这里保存；截图会在保存时逐张选择资料库收藏。
        </p>
      )}
      <ul className="reference-groups-list">
        {groups?.map((g) => (
          <li key={g.id} className="reference-group" data-id={g.id}>
            {renaming?.id === g.id ? (
              <span className="reference-group-name">
                <input
                  aria-label="参考组名称"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                />
                <button
                  type="button"
                  disabled={!renaming.name.trim()}
                  onClick={() => void run(() => renameReferenceGroup(g.id, renaming.name), () => (setRenaming(null), null))}
                >
                  保存名称
                </button>
                <button type="button" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <strong className="reference-group-name">{g.name}</strong>
            )}
            {g.problem ? (
              <span className="reference-group-problem">{g.problem}</span>
            ) : (
              <span className="reference-group-meta">
                {g.memberCount} 个成员 · {libraries(g.libraryIds)}
              </span>
            )}
            <span className="reference-group-actions">
              {!g.problem && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => openReferenceGroup(g.id),
                        (n) => (n === 0 ? "成员都已在桌面上" : `已钉出 ${String(n)} 个成员`),
                      )
                    }
                  >
                    钉到桌面
                  </button>
                  <button
                    type="button"
                    title="来自这个参考组的钉图更新原成员，其他资料库钉图加为新成员"
                    disabled={!!captureSave || saving}
                    onClick={() => void run(() => beginSave({ groupId: g.id }))}
                  >
                    存入桌面钉图
                  </button>
                  <button type="button" aria-expanded={expanded?.group.id === g.id} onClick={() => toggleMembers(g.id)}>
                    成员
                  </button>
                  <button type="button" onClick={() => setRenaming({ id: g.id, name: g.name })}>
                    重命名
                  </button>
                  <button
                    type="button"
                    title="带上所用原图与标签、备注、来源的快照，可带到别的电脑"
                    onClick={() =>
                      void run(
                        () => exportReferenceGroupPackage(g.id),
                        (path) => (path ? `已导出参考组包：${String(path)}` : null),
                      )
                    }
                  >
                    导出参考组包
                  </button>
                </>
              )}
              {deleting === g.id ? (
                <>
                  <button
                    type="button"
                    onClick={() => void run(() => deleteReferenceGroup(g.id), () => (setDeleting(null), null))}
                  >
                    确认删除
                  </button>
                  <button type="button" onClick={() => setDeleting(null)}>
                    取消
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setDeleting(g.id)}>
                  删除
                </button>
              )}
            </span>
            {expanded?.group.id === g.id && (
              <ol className="reference-group-members">
                {expanded.members.map((m, i) => {
                  const member = expanded.group.members[i];
                  const crop = member?.crop;
                  return (
                    <li
                      key={m.memberId}
                      className={m.state.kind === "unavailable" ? "reference-group-member-unavailable" : undefined}
                    >
                      <span>
                        {libraryNames.get(m.libraryId) ?? "未登记的资料库"} ·{" "}
                        {crop ? `局部 ${crop.width}×${crop.height}` : "整图"}
                      </span>
                      <span>{memberState(m)}</span>
                      <button
                        type="button"
                        onClick={() => void run(() => removeGroupMember(g.id, m.memberId))}
                      >
                        移出
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
