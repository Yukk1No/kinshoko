import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import type { KeyboardEvent } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Link2, PenLine, Plus, Tags, Trash2, X } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import { Select, type SelectOption } from "../ui/Select";
import { tagOption } from "../search/tagOptions";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import { createSharedTagGroup, editSharedTagGroup, sharedTagGroups, isLensChanged } from "../ipc";
import { LIMIT, TagMarks, tagName, useCandidateState, type Lens } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { NameInput } from "./SidebarPane";

type Props = {
  /** Kept for callers from the previous local UI; group ownership is always application-wide. */
  libraryId?: string;
  safe: boolean;
  generation: number;
  label?: string;
  onBrowse?: (tagIds: string[]) => void;
  onError: (error: unknown) => void;
};

const KINDS: (TagNamespace | "")[] = ["", "artist", "character", "work", "general"];
const kindLabel = (kind: TagNamespace | "") => i18n.t(`tagGroups:kind.${kind || "custom"}`);
const kindOptions = (): SelectOption<TagNamespace | "">[] => KINDS.map((value) => ({ value, label: kindLabel(value) }));

/** Esc 只收起这一行编辑，不连带关掉外面的“编辑分组”对话框。 */
function escape(e: KeyboardEvent, done: () => void) {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation(); done();
}

/** 新建标签分组：列表末行展开成一行，名称和分组内容（自己挑选成员，或列出一个命名空间的全部标签）。 */
function NewGroup({ onDone }: { onDone: (group: { name: string; namespace: TagNamespace | null } | null) => void }) {
  const { t } = useTranslation("tagGroups", { keyPrefix: "create" });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TagNamespace | "">("");
  const submit = () => onDone(name.trim() ? { name: name.trim(), namespace: kind || null } : null);
  return (
    <div className="k-group-new">
      <span className="k-group-icon" aria-hidden="true"><Tags size={16} /></span>
      <input
        className="k-input"
        aria-label={t("nameLabel")}
        placeholder={t("namePlaceholder")}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          escape(e, () => onDone(null));
        }}
      />
      <Select label={t("kindLabel")} className="k-group-kind" value={kind} onChange={setKind} options={kindOptions()} />
      <button type="button" className="k-btn" onClick={() => onDone(null)}><span className="k-label">{t("cancel")}</span></button>
      <button type="button" className="k-btn" disabled={!name.trim()} onClick={submit}><span className="k-label">{t("submit")}</span></button>
    </div>
  );
}

/** “给分组加标签”：成员行末尾的输入框，按名称或别名从工作区可见标签里挑一个；已在分组里的不再列出，条数照样补足。 */
function PickTag({ lens, members, onPick, onCancel }: { lens: Lens; members: string[]; onPick: (tag: TagLabel) => void; onCancel: () => void }) {
  const { t } = useTranslation("tagGroups", { keyPrefix: "pick" });
  const [text, setText] = useState("");
  const { list, ready } = useCandidateState(lens, text, undefined, LIMIT + members.length);
  const found = list.filter((c) => !members.includes(c.tag.id)).slice(0, LIMIT);
  return (
    <li className="k-group-pick">
      <Combobox
        label={t("label")}
        placeholder={t("placeholder")}
        inline
        autoFocus
        value={text}
        onValueChange={setText}
        options={found.map((c) => tagOption(c, text))}
        empty={ready ? t("none") : undefined}
        onSelect={(option) => onPick(option.tag)}
        onKeyDown={(e) => escape(e, onCancel)}
      />
      <button type="button" className="k-icon-btn is-xs" aria-label={t("cancelLabel")} title={t("cancelTitle")} onClick={onCancel}><X size={12} aria-hidden="true" /></button>
    </li>
  );
}

/** Reuses the formal sidebar editor and the accepted prototype's tag-chip structure.
 * Shared IDs are already query identities. Group actions never edit an image's tags. */
export function TagGroupsPane({ safe, generation, onBrowse, onError, label: labelProp }: Props) {
  const { t } = useTranslation("tagGroups");
  const label = labelProp ?? t("label");
  const [found, setFound] = useState<{ key: string; safe: boolean | null; groups: CatalogGroupView[] }>({ key: "", safe: null, groups: [] });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const view = JSON.stringify([safe, generation]);
  const lang = useUiLang();
  const key = JSON.stringify([view, refresh, lang]);
  const current = useRef(key); current.current = key;
  // Preserve editor identity during refresh, but never display stale server labels or members.
  const groups = found.safe === safe ? found.groups : [];
  const fresh = found.key === key;
  const busy = pendingKey === key;
  const lens: Lens = { libraryId: "workspace", safe, generation, workspace: true };

  useEffect(() => {
    let alive = true;
    sharedTagGroups(lang, safe).then(
      (value) => { if (alive && current.current === key) setFound({ key, safe, groups: value ?? [] }); },
      (error) => { if (alive && current.current === key && !isLensChanged(error)) onError(error); },
    );
    return () => { alive = false; };
  }, [key, safe, onError, lang]);
  useEffect(() => { setCreating(false); setRenaming(null); setPicking(null); setDeleting(null); }, [safe]);
  useEffect(() => {
    if (!fresh) return;
    setRenaming((id) => id !== null && !groups.some((group) => group.id === id) ? null : id);
    setPicking((id) => id !== null && !groups.some((group) => group.id === id) ? null : id);
    setDeleting((id) => id !== null && !groups.some((group) => group.id === id) ? null : id);
  }, [fresh, groups]);
  // 操作期间按钮被禁用、刷新时行会重建，焦点会丢到页面上。记下焦点所在操作（data-focus-key），
  // 刷新完成后按同一键找回；该操作已不存在或不可用时，依次退到同成员或同分组的其他操作。
  const section = useRef<HTMLElement>(null);
  const restore = useRef<string | null>(null);
  const remember = (fallback?: string) => {
    const active = document.activeElement as HTMLElement | null;
    const focused = active && section.current?.contains(active) ? active.dataset.focusKey : undefined;
    restore.current = focused ?? fallback ?? restore.current;
  };
  // Layout effect: focus returns in the same commit that remounts the rows, before paint.
  useLayoutEffect(() => {
    const wanted = restore.current;
    if (!fresh || busy || wanted === null || !section.current) return;
    restore.current = null;
    const parts = wanted.split(":");
    const group = parts[0];
    const chain = [wanted];
    if (parts.length === 3) chain.push(...["prev", "next", "remove", "chip"].map((action) => `${group}:${parts[1]}:${action}`));
    else chain.push(`${group}:up`, `${group}:down`);
    chain.push(`${group}:name`, `${group}:rename`, "new");
    const targets = [...section.current.querySelectorAll<HTMLButtonElement>("[data-focus-key]")];
    for (const candidate of chain) {
      const target = targets.find((element) => element.dataset.focusKey === candidate);
      if (target && !target.disabled) { target.focus(); return; }
    }
  }, [fresh, busy, groups]);
  const run = async (action: Promise<unknown>) => {
    remember();
    setPendingKey(key);
    try {
      await action;
      if (current.current === key) setRefresh((n) => n + 1);
    } catch (error) {
      if (current.current === key) onError(error);
    } finally { setPendingKey((pending) => pending === key ? null : pending); }
  };
  const edit = (action: CatalogGroupEdit) => run(editSharedTagGroup(action, safe));
  const moved = (ids: string[], index: number, delta: number) => {
    const result = [...ids]; const other = index + delta;
    [result[index], result[other]] = [result[other], result[index]];
    return result;
  };
  const deletingGroup = groups.find((group) => group.id === deleting);
  // 设计系统 SettingsList 的外框：每个分组一行，28 px 图标方块、名称、靠右的成员数（命名空间分组是胶囊）；
  // 悬停或键盘聚焦时露出改名、上移、下移、删除。成员是 TagChip，悬停露出前移、后移、移出，末尾是幽灵按钮“加标签”。
  // 末行是“新建分组”。删除先确认（#98，design/ui-system/README.md）。
  return (
    <section ref={section} className="sidebar-tag-groups k-groups" aria-label={label} aria-busy={busy || !fresh}>
      {!fresh && <p className="k-set-note" role="status">{t("updating")}</p>}
      <div className="k-group-list">
      <div className="k-group-rows">
      {groups.map((group, index) => {
        const custom = group.namespace === null;
        const origin = group.sources?.length ? group.sources.map((source) => t("group.originItem", { library: source.libraryName, group: source.groupName })).join(t("group.originSeparator")) : null;
        const ids = group.tags.map((member) => member.tag.id);
        return <div key={group.id} role="group" aria-label={fresh ? group.name : undefined} className="k-group">
          {renaming === group.id ? <div className="k-group-head is-renaming" onKeyDown={(e) => escape(e, () => {})}>
            <span className="k-group-icon" aria-hidden="true"><Tags size={16} /></span>
            <NameInput label={t("group.rename")} initial={group.name} onDone={(name) => {
              setRenaming(null);
              remember(`${group.id}:rename`);
              if (name && name !== group.name) void edit({ kind: "rename", groupId: group.id, name });
            }} />
          </div> : fresh && (
            <div className="k-group-head">
              <span className="k-group-icon" aria-hidden="true"><Tags size={16} /></span>
              <button type="button" className="k-group-name" data-focus-key={`${group.id}:name`} aria-label={t("group.nameCount", { name: group.name, count: group.tags.length })}
                disabled={busy || !onBrowse || !group.tags.length} title={onBrowse && group.tags.length ? t("group.browseTitle") : t("group.renameTitle")}
                onClick={() => onBrowse?.(ids)} onDoubleClick={() => setRenaming(group.id)}>
                <span className="k-group-label k-label">{group.name}</span>
                {origin && <span className="k-group-origin" role="img" aria-label={t("group.origin", { origin })} title={t("group.origin", { origin })}><Link2 size={14} aria-hidden="true" /></span>}
              </button>
              <span className="k-group-acts">
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:rename`} aria-label={t("group.renameLabel", { name: group.name })} title={t("group.renameAction")} disabled={busy} onClick={() => setRenaming(group.id)}><PenLine size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:up`} aria-label={t("group.upLabel", { name: group.name })} title={t("group.up")} disabled={busy || index === 0}
                  onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, -1) })}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:down`} aria-label={t("group.downLabel", { name: group.name })} title={t("group.down")} disabled={busy || index === groups.length - 1}
                  onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, 1) })}><ArrowDown size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm is-danger" data-focus-key={`${group.id}:delete`} aria-label={t("group.deleteLabel", { name: group.name })} disabled={busy}
                  title={t("group.delete")} onClick={() => setDeleting(group.id)}><Trash2 size={14} aria-hidden="true" /></button>
              </span>
              {custom ? <span className="k-group-count k-label">{t("group.tagCount", { count: group.tags.length })}</span>
                : <span className="k-pill"><span className="k-label">{group.namespace && kindLabel(group.namespace)}</span></span>}
            </div>
          )}
          {((fresh && (group.tags.length > 0 || custom)) || picking === group.id) && <ul className="k-group-members">
            {fresh && group.tags.map(({ tag, count }, memberIndex) => {
              const name = tagName(tag);
              return <li key={tag.id} className="k-group-member">
                <button type="button" className="k-group-chip" data-focus-key={`${group.id}:${tag.id}:chip`} aria-label={t("member.count", { name, count })} disabled={!onBrowse}
                  onClick={() => onBrowse?.([tag.id])}>
                  <span className="k-group-chip-name k-label">{name}<TagMarks tag={tag} /></span><span className="k-group-chip-count k-label">{count}</span>
                </button>
                {custom && <span className="k-group-member-acts">
                  <button type="button" className="k-group-chip-x" data-focus-key={`${group.id}:${tag.id}:prev`} aria-label={t("member.prevLabel", { tag: name, group: group.name })} title={t("member.prev")} disabled={busy || memberIndex === 0}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, -1) })}><ArrowLeft size={12} aria-hidden="true" /></button>
                  <button type="button" className="k-group-chip-x" data-focus-key={`${group.id}:${tag.id}:next`} aria-label={t("member.nextLabel", { tag: name, group: group.name })} title={t("member.next")} disabled={busy || memberIndex === group.tags.length - 1}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, 1) })}><ArrowRight size={12} aria-hidden="true" /></button>
                  <button type="button" className="k-group-chip-x" data-focus-key={`${group.id}:${tag.id}:remove`} aria-label={t("member.removeLabel", { tag: name, group: group.name })} title={t("member.remove")} disabled={busy}
                    onClick={() => void edit({ kind: "removeMembers", groupId: group.id, tagIds: [tag.id] })}><X size={12} aria-hidden="true" /></button>
                </span>}
              </li>;
            })}
            {picking === group.id ? <PickTag lens={lens} members={ids} onCancel={() => {
              // 收起后焦点回到“加标签”，不丢到页面上。
              setPicking(null);
              requestAnimationFrame(() => section.current?.querySelector<HTMLElement>(`[data-focus-key="${group.id}:add"]`)?.focus());
            }} onPick={(tag) => {
              setPicking(null); remember(`${group.id}:add`); void edit({ kind: "addMembers", groupId: group.id, tagIds: [tag.id] });
            }} /> : custom && <li>
              <button type="button" className="k-group-add" data-focus-key={`${group.id}:add`} aria-label={t("member.addLabel", { group: group.name })} disabled={busy} onClick={() => setPicking(group.id)}>
                <Plus size={14} aria-hidden="true" /><span className="k-label">{t("member.add")}</span></button>
            </li>}
          </ul>}
        </div>;
      })}
      </div>
      {creating ? <NewGroup onDone={(group) => {
        setCreating(false);
        remember("new");
        if (group) void run(createSharedTagGroup(group.name, group.namespace));
      }} /> : <button type="button" className="k-group-create" aria-label={t("create.open")} data-focus-key="new" disabled={busy || !fresh} onClick={() => setCreating(true)}>
        <span className="k-group-icon" aria-hidden="true"><Plus size={16} /></span><span className="k-label">{t("create.button")}</span></button>}
      </div>
      <AlertDialog.Root open={!!deletingGroup} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="k-backdrop" />
          <AlertDialog.Popup className="k-dialog is-alert">
            <AlertDialog.Title className="k-dialog-title">{t("deleteConfirm.title")}</AlertDialog.Title>
            <AlertDialog.Description className="k-dialog-desc">{t("deleteConfirm.description", { name: deletingGroup?.name })}</AlertDialog.Description>
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <AlertDialog.Close className="k-btn"><span className="k-label">{t("deleteConfirm.cancel")}</span></AlertDialog.Close>
              <button type="button" className="k-btn is-danger" onClick={() => {
                const id = deleting!; setDeleting(null);
                // 删掉的分组没有可回的位置：回到相邻分组，没有时回到“新建分组”。
                const at = groups.findIndex((g) => g.id === id), next = groups[at + 1] ?? groups[at - 1];
                restore.current = next ? `${next.id}:name` : "new";
                void edit({ kind: "delete", groupId: id });
              }}><span className="k-label">{t("deleteConfirm.submit")}</span></button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

// 设置里的全局标签分组在它自己的文件里；旧的导入路径照常可用。
export { SharedTagGroupsSettings } from "./SharedTagGroupsSettings";
