import { SaveDestinationDialog } from "../library/SaveDestination";
import { useCallback, useEffect, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { BookmarkPlus, FolderInput, Layers, ListTree, MoreHorizontal, PackageOpen, Trash2 } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { CaptureGroupSaveDialog, captureChoices, type CaptureSave } from "./CaptureGroupSaveDialog";
import { GroupNameForm } from "./GroupNameForm";
import { useToast } from "../ui/Toast";
import { ago } from "./relativeTime";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { MemberStatus } from "../bindings/MemberStatus";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import type { CaptureChoice } from "../bindings/CaptureChoice";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import {
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
  thumbnailUrl,
  captureUrl,
  renameReferenceGroup,
  savePinsToGroup,
  saveReferenceGroup,
} from "../ipc";

type SaveTarget = { name: string } | { groupId: string };

function memberState(status: MemberStatus): string {
  switch (status.state.kind) {
    case "available":
      return status.state.sealed ? "安全模式下原位遮蔽" : "可用";
    case "unavailable":
      return status.state.message;
  }
}

/**
 * 参考组（#66）：把桌面钉图存成参考组，打开参考组把成员按原来的局部与摆放钉回桌面。截图可以收藏进
 * 图库后入组，也可以只存在参考组里（#270）。
 * 参考组独立于资料库保存，成员可来自多个资料库；资料库不可用、图已删除的成员保留布局并写出原因，
 * 安全模式下被封印的成员在钉图上原位遮蔽。
 *
 * 参考组包（#68）：导出时带上所用原图与整理信息快照，可带到别的电脑；导入时原图进当前资料库
 * （`libraryId`），另存为新的参考组。
 */
export function ReferenceGroupsPanel({}: { libraryId?: string | null }) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [libraryNames, setLibraryNames] = useState<Map<string, string>>(new Map());
  const [libraryOptions, setLibraryOptions] = useState<LibraryRegistration[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toast = useToast();
  /** 结果用轻提示回报；没有 ToastProvider 时（单独渲染面板）写在面板里。 */
  const tell = (text: string | null) => {
    if (!text) return;
    if (toast) toast.show({ title: text, tone: "success" });
    else setNotice(text);
  };
  const [expanded, setExpanded] = useState<ReferenceGroupView | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [captureSave, setCaptureSave] = useState<CaptureSave<SaveTarget> | null>(null);
  const [importing,setImporting]=useState(false);
  const [naming, setNaming] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  /** 卡片缩略图用的成员状态，按参考组 id 与更新时间缓存。 */
  const [thumbs, setThumbs] = useState<Map<string, { at: number; members: MemberStatus[] }>>(new Map());
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
      if (done) tell(done(value));
    } catch (e) {
      setError(String(e));
    }
  };

  const libraries = (ids: string[]) => ids.map((id) => libraryNames.get(id) ?? "未登记的图库").join("、") || "不在图库里";

  // 卡片缩略图：读一次成员状态；参考组更新后重读。
  useEffect(() => {
    if (!groups) return;
    let alive = true;
    for (const g of groups) {
      if (g.problem || thumbs.get(g.id)?.at === g.updatedAt) continue;
      referenceGroup(g.id).then((v) => {
        if (alive && v) setThumbs((prev) => new Map(prev).set(g.id, { at: g.updatedAt, members: v.members }));
      }, () => {});
    }
    return () => { alive = false; };
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = groups?.some((g) => g.id === active) ? active : groups?.[0]?.id ?? null;

  const toggleMembers = (id: string) =>
    expanded?.group.id === id ? setExpanded(null) : void run(() => referenceGroup(id).then(setExpanded));

  const save = async (target: SaveTarget, choices: CaptureChoice[]) => {
    if ("name" in target) {
      if (choices.length) await saveReferenceGroup(target.name, choices);
      else await saveReferenceGroup(target.name);
      setName("");
      setNaming(false);
      tell("已把桌面钉图存为参考组");
    } else {
      if (choices.length) await savePinsToGroup(target.groupId, choices);
      else await savePinsToGroup(target.groupId);
      tell("已把桌面钉图存进这个参考组");
    }
    setCaptureSave(null);
  };
  const beginSave = async (target: SaveTarget) => {
    setSaving(true);
    try {
      const entries = await ("groupId" in target ? groupSaveCaptures(target.groupId) : groupSaveCaptures());
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
      await run(() => save(captureSave.target, captureChoices(captureSave)));
    } finally { setSaving(false); }
  };

  const deletingGroup = groups?.find((g) => g.id === deleting);
  return (
    <section className="reference-groups" aria-label="参考组">
      <header className="reference-groups-bar">
        <h2>参考组</h2>
        {naming ? <GroupNameForm className="is-new" title="新参考组" label="新参考组名称" placeholder="给这组钉图起个名字"
          value={name} onChange={setName} busy={saving} blocked={!!captureSave}
          onCancel={() => { setNaming(false); setName(""); }} onSubmit={() => void run(() => beginSave({ name }))} /> : <button type="button" className="k-btn is-primary group-save" disabled={!!captureSave || saving} onClick={() => setNaming(true)}>
          <BookmarkPlus size={15} aria-hidden="true" /><span className="k-label">存下桌面钉图</span>
        </button>}
      </header>
      {importing && <SaveDestinationDialog title="导入参考组包" confirmLabel="选择参考组包并导入" onClose={() => setImporting(false)} onConfirm={async (destination) => {
        const group = await importReferenceGroupPackage(destination.libraryId, destination);
        if (group) tell(`已导入参考组「${group.name}」，原图保存到所选图库和文件夹`);
      }} />}
      {error && <p className="group-note is-error" role="alert">{error}</p>}
      {notice && <p className="group-note" role="status">{notice}</p>}
      {captureSave && <CaptureGroupSaveDialog value={captureSave} onChange={setCaptureSave} libraries={libraryOptions} saving={saving}
        onClose={() => setCaptureSave(null)} onConfirm={() => void confirmCaptures()} />}
      {groups && groups.length === 0 && (
        <p className="reference-groups-empty">还没有参考组。把整图或局部钉到桌面摆好，再在这里存下。</p>
      )}
      <ul className="reference-groups-list">
        {groups?.map((g) => {
          const on = g.id === current;
          const members = thumbs.get(g.id)?.members ?? [];
          return (
            <li key={g.id} className={`reference-group${on ? " is-on" : ""}`} data-id={g.id}>
              <button type="button" className="group-card-head" aria-current={on || undefined} onClick={() => setActive(g.id)}>
                {members.length > 0 && <span className="group-thumbs" aria-hidden="true">
                  {members.slice(0, 5).map((m) => <span key={m.memberId}
                    className={`group-thumb${m.state.kind === "available" ? m.state.sealed ? " is-sealed" : "" : " is-missing"}`}>
                    {m.state.kind === "available" && !m.state.sealed && <img src={"libraryId" in m ? thumbnailUrl(`${m.libraryId}/${m.imageId}/128`) : captureUrl(`group/${g.id}/${m.memberId}`)} alt="" draggable={false} />}
                  </span>)}
                </span>}
                {renaming?.id !== g.id && <strong className="reference-group-name">{g.name}</strong>}
                {g.problem
                  ? <span className="reference-group-problem">{g.problem}</span>
                  : <span className="reference-group-meta k-parts"><span>{g.memberCount} 张</span><span>{libraries(g.libraryIds)}</span><span>{ago(g.updatedAt)}</span></span>}
              </button>
              {renaming?.id === g.id && (
                <GroupNameForm title="改名" label="参考组名称" value={renaming.name} primary={false}
                  onChange={(value) => setRenaming({ id: g.id, name: value })} onCancel={() => setRenaming(null)}
                  onSubmit={() => void run(() => renameReferenceGroup(g.id, renaming.name), () => (setRenaming(null), null))} />
              )}
              {on && renaming?.id !== g.id && (g.problem ? (
                <span className="reference-group-actions">
                  <button type="button" className="k-btn is-sm" onClick={() => setDeleting(g.id)}><Trash2 size={13} aria-hidden="true" /><span className="k-label">删除</span></button>
                </span>
              ) : (
                <span className="reference-group-actions">
                  <button type="button" className="k-btn is-sm" onClick={() => void run(
                    () => openReferenceGroup(g.id),
                    (n) => (n === 0 ? "成员都已在桌面上" : `已钉出 ${String(n)} 个成员`),
                  )}><Layers size={13} aria-hidden="true" /><span className="k-label">摆到桌面</span></button>
                  <button type="button" className="k-btn is-sm" onClick={() => setRenaming({ id: g.id, name: g.name })}><span className="k-label">改名</span></button>
                  <Menu.Root>
                    <Menu.Trigger className="k-icon-btn" aria-label="更多操作" title="更多操作"><MoreHorizontal size={15} aria-hidden="true" /></Menu.Trigger>
                    <MenuPopup label={`${g.name} 的更多操作`}>
                      <MenuItem icon={<BookmarkPlus size={14} />} disabled={!!captureSave || saving}
                        onClick={() => void run(() => beginSave({ groupId: g.id }))}>存入桌面钉图</MenuItem>
                      <MenuItem icon={<ListTree size={14} />} onClick={() => toggleMembers(g.id)}>
                        {expanded?.group.id === g.id ? "收起成员" : "查看成员"}</MenuItem>
                      <MenuItem icon={<PackageOpen size={14} />} onClick={() => void run(
                        () => exportReferenceGroupPackage(g.id),
                        (path) => (path ? `已导出参考组包：${String(path)}` : null),
                      )}>导出参考组包</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => setDeleting(g.id)}>删除</MenuItem>
                    </MenuPopup>
                  </Menu.Root>
                </span>
              ))}
              {expanded?.group.id === g.id && (
                <ol className="reference-group-members" aria-label={`${g.name} 的成员`}>
                  {expanded.members.map((m, i) => {
                    const crop = expanded.group.members[i]?.crop;
                    return (
                      <li key={m.memberId} className={m.state.kind === "unavailable" ? "reference-group-member-unavailable" : undefined}>
                        <span className="k-parts"><span>{"libraryId" in m ? libraryNames.get(m.libraryId) ?? "未登记的图库" : "参考组里的截图"}</span><span>{crop ? `局部 ${crop.width} × ${crop.height}` : "整图"}</span></span>
                        <span>{memberState(m)}</span>
                        <button type="button" className="k-btn is-sm" onClick={() => void run(() => removeGroupMember(g.id, m.memberId))}><span className="k-label">移出</span></button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      <footer className="reference-groups-foot">
        <button type="button" className="k-btn is-sm is-ghost" onClick={() => setImporting(true)}><FolderInput size={13} aria-hidden="true" /><span className="k-label">导入参考组包</span></button>
      </footer>
      <AlertDialog.Root open={!!deletingGroup} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="k-backdrop" />
          <AlertDialog.Popup className="k-dialog is-alert">
            <AlertDialog.Title className="k-dialog-title">删除参考组</AlertDialog.Title>
            <AlertDialog.Description className="k-dialog-desc">「{deletingGroup?.name}」会被删除，图库里的原图不受影响；只存在这个参考组里的截图一起删除。</AlertDialog.Description>
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <AlertDialog.Close className="k-btn"><span className="k-label">取消</span></AlertDialog.Close>
              <button type="button" className="k-btn is-danger" onClick={() => {
                const id = deleting!;
                void run(() => deleteReferenceGroup(id), () => (setDeleting(null), null));
              }}><span className="k-label">删除</span></button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
