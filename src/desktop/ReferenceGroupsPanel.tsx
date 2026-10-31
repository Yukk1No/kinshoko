import { SaveDestinationDialog } from "../library/SaveDestination";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n/instance";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { BookmarkPlus, FolderInput, Layers, ListTree, MoreHorizontal, PackageOpen, Trash2 } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { CaptureGroupSaveDialog } from "./CaptureGroupSaveDialog";
import { draftCaptureSave, type CaptureSaveDraft, type CaptureSavePlan } from "./captureSavePlan";
import { GroupNameForm } from "./GroupNameForm";
import { useToast } from "../ui/Toast";
import { ago } from "./relativeTime";
import { describeCommandError } from "../ipc/commandError";
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
      return i18n.t(status.state.sealed ? "desktop:groups.sealed" : "desktop:groups.available");
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
  const { t } = useTranslation("desktop", { keyPrefix: "groups" });
  /** 结果用轻提示回报；没有 ToastProvider 时（单独渲染面板）写在面板里。 */
  const tell = (text: string | null) => {
    if (!text) return;
    if (toast) toast.show({ title: text, tone: "success" });
    else setNotice(text);
  };
  const [expanded, setExpanded] = useState<ReferenceGroupView | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [captureSave, setCaptureSave] = useState<CaptureSaveDraft<SaveTarget> | null>(null);
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

  const libraries = (ids: string[]) => ids.map((id) => libraryNames.get(id) ?? t("unregisteredLibrary")).join(t("librarySeparator")) || t("notInLibrary");

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
      tell(t("savedNew"));
    } else {
      if (choices.length) await savePinsToGroup(target.groupId, choices);
      else await savePinsToGroup(target.groupId);
      tell(t("savedInto"));
    }
    setCaptureSave(null);
  };
  const beginSave = async (target: SaveTarget) => {
    setSaving(true);
    try {
      const entries = await ("groupId" in target ? groupSaveCaptures(target.groupId) : groupSaveCaptures());
      if (!entries.length) { await save(target, []); return; }
      setCaptureSave(draftCaptureSave(target, entries, libraryOptions));
    } finally { setSaving(false); }
  };
  const confirmCaptures = async (plan: CaptureSavePlan<SaveTarget>) => {
    setSaving(true);
    try {
      await run(() => save(plan.target, plan.choices));
    } finally { setSaving(false); }
  };

  const deletingGroup = groups?.find((g) => g.id === deleting);
  return (
    <section className="reference-groups" aria-label={t("label")}>
      <header className="reference-groups-bar">
        <h2>{t("label")}</h2>
        {naming ? <GroupNameForm className="is-new" title={t("newTitle")} label={t("newLabel")} placeholder={t("newPlaceholder")}
          value={name} onChange={setName} busy={saving} blocked={!!captureSave}
          onCancel={() => { setNaming(false); setName(""); }} onSubmit={() => void run(() => beginSave({ name }))} /> : <button type="button" className="k-btn is-primary group-save" disabled={!!captureSave || saving} onClick={() => setNaming(true)}>
          <BookmarkPlus size={15} aria-hidden="true" /><span className="k-label">{t("savePins")}</span>
        </button>}
      </header>
      {importing && <SaveDestinationDialog title={t("importTitle")} confirmLabel={t("importConfirm")} onClose={() => setImporting(false)} onConfirm={async (destination) => {
        const group = await importReferenceGroupPackage(destination.libraryId, destination);
        if (group) tell(t("imported", { name: group.name }));
      }} />}
      {error && <p className="group-note is-error" role="alert">{error}</p>}
      {notice && <p className="group-note" role="status">{notice}</p>}
      {captureSave && <CaptureGroupSaveDialog value={captureSave} onChange={setCaptureSave} libraries={libraryOptions} saving={saving}
        onClose={() => setCaptureSave(null)} onConfirm={(plan) => void confirmCaptures(plan)} />}
      {groups && groups.length === 0 && (
        <p className="reference-groups-empty">{t("empty")}</p>
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
                  ? <span className="reference-group-problem">{describeCommandError(g.problem)}</span>
                  : <span className="reference-group-meta k-parts"><span>{t("memberCount", { count: g.memberCount })}</span><span>{libraries(g.libraryIds)}</span><span>{ago(g.updatedAt)}</span></span>}
              </button>
              {renaming?.id === g.id && (
                <GroupNameForm title={t("renameTitle")} label={t("nameLabel")} value={renaming.name} primary={false}
                  onChange={(value) => setRenaming({ id: g.id, name: value })} onCancel={() => setRenaming(null)}
                  onSubmit={() => void run(() => renameReferenceGroup(g.id, renaming.name), () => (setRenaming(null), null))} />
              )}
              {on && renaming?.id !== g.id && (g.problem ? (
                <span className="reference-group-actions">
                  <button type="button" className="k-btn is-sm" onClick={() => setDeleting(g.id)}><Trash2 size={13} aria-hidden="true" /><span className="k-label">{t("delete")}</span></button>
                </span>
              ) : (
                <span className="reference-group-actions">
                  <button type="button" className="k-btn is-sm" onClick={() => void run(
                    () => openReferenceGroup(g.id),
                    (n) => (n === 0 ? t("allOnDesktop") : t("opened", { count: Number(n) })),
                  )}><Layers size={13} aria-hidden="true" /><span className="k-label">{t("open")}</span></button>
                  <button type="button" className="k-btn is-sm" onClick={() => setRenaming({ id: g.id, name: g.name })}><span className="k-label">{t("rename")}</span></button>
                  <Menu.Root>
                    <Menu.Trigger className="k-icon-btn" aria-label={t("more")} title={t("more")}><MoreHorizontal size={15} aria-hidden="true" /></Menu.Trigger>
                    <MenuPopup label={t("moreLabel", { name: g.name })}>
                      <MenuItem icon={<BookmarkPlus size={14} />} disabled={!!captureSave || saving}
                        onClick={() => void run(() => beginSave({ groupId: g.id }))}>{t("saveInto")}</MenuItem>
                      <MenuItem icon={<ListTree size={14} />} onClick={() => toggleMembers(g.id)}>
                        {expanded?.group.id === g.id ? t("hideMembers") : t("showMembers")}</MenuItem>
                      <MenuItem icon={<PackageOpen size={14} />} onClick={() => void run(
                        () => exportReferenceGroupPackage(g.id),
                        (path) => (path ? t("exported", { path: String(path) }) : null),
                      )}>{t("export")}</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 size={14} />} danger onClick={() => setDeleting(g.id)}>{t("delete")}</MenuItem>
                    </MenuPopup>
                  </Menu.Root>
                </span>
              ))}
              {expanded?.group.id === g.id && (
                <ol className="reference-group-members" aria-label={t("membersLabel", { name: g.name })}>
                  {expanded.members.map((m, i) => {
                    const crop = expanded.group.members[i]?.crop;
                    return (
                      <li key={m.memberId} className={m.state.kind === "unavailable" ? "reference-group-member-unavailable" : undefined}>
                        <span className="k-parts"><span>{"libraryId" in m ? libraryNames.get(m.libraryId) ?? t("unregisteredLibrary") : t("captureMember")}</span><span>{crop ? t("crop", { width: crop.width, height: crop.height }) : t("whole")}</span></span>
                        <span>{memberState(m)}</span>
                        <button type="button" className="k-btn is-sm" onClick={() => void run(() => removeGroupMember(g.id, m.memberId))}><span className="k-label">{t("remove")}</span></button>
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
        <button type="button" className="k-btn is-sm is-ghost" onClick={() => setImporting(true)}><FolderInput size={13} aria-hidden="true" /><span className="k-label">{t("import")}</span></button>
      </footer>
      <AlertDialog.Root open={!!deletingGroup} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="k-backdrop" />
          <AlertDialog.Popup className="k-dialog is-alert">
            <AlertDialog.Title className="k-dialog-title">{t("deleteTitle")}</AlertDialog.Title>
            <AlertDialog.Description className="k-dialog-desc">{t("deleteDescription", { name: deletingGroup?.name })}</AlertDialog.Description>
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <AlertDialog.Close className="k-btn"><span className="k-label">{t("cancel")}</span></AlertDialog.Close>
              <button type="button" className="k-btn is-danger" onClick={() => {
                const id = deleting!;
                void run(() => deleteReferenceGroup(id), () => (setDeleting(null), null));
              }}><span className="k-label">{t("delete")}</span></button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
