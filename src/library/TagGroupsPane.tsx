import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, PenLine, Plus, Tags, Trash2, X } from "lucide-react";
import { FluidList, FluidRow } from "../ui/FluidList";
import { Combobox } from "../ui/Combobox";
import { Select, type SelectOption } from "../ui/Select";
import { tagOption } from "../search/tagOptions";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import { createSharedTagGroup, editSharedTagGroup, sharedTagGroups, onSafeModeSetting, onWorkspaceChanged, safeMode, workspaceStatus, isLensChanged } from "../ipc";
import { LIMIT, TagMarks, UI_LANG, tagName, useCandidateState, type Lens } from "../search/SearchBox";
import { NameInput } from "./SidebarPane";

type Props = {
  /** Kept for callers from the previous local UI; group ownership is always application-wide. */
  libraryId?: string;
  safe: boolean;
  generation: number;
  label?: string;
  onBrowse?: (tagIds: string[]) => void;
  onError: (message: string) => void;
};

const KINDS: SelectOption<TagNamespace | "">[] = [
  { value: "", label: "自选标签" },
  { value: "artist", label: "全部作者" },
  { value: "character", label: "全部角色" },
  { value: "work", label: "全部作品" },
  { value: "general", label: "一般标签" },
];

/** Esc 只收起这一行编辑，不连带关掉外面的“编辑分组”对话框。 */
function escape(e: KeyboardEvent, done: () => void) {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation(); done();
}

/** 新建标签分组：一行，名称和分组内容（自己挑选成员，或列出一个命名空间的全部标签）。 */
function NewGroup({ onDone }: { onDone: (group: { name: string; namespace: TagNamespace | null } | null) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TagNamespace | "">("");
  const submit = () => onDone(name.trim() ? { name: name.trim(), namespace: kind || null } : null);
  return (
    <div className="k-group-new">
      <Tags size={16} aria-hidden="true" className="k-group-icon" />
      <input
        className="k-input"
        aria-label="新标签分组名称"
        placeholder="分组名称"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          escape(e, () => onDone(null));
        }}
      />
      <Select label="分组内容" className="k-group-kind" value={kind} onChange={setKind} options={KINDS} />
      <button type="button" className="k-btn" onClick={() => onDone(null)}>取消</button>
      <button type="button" className="k-btn" disabled={!name.trim()} onClick={submit}>建立</button>
    </div>
  );
}

/** “给分组加标签”：成员行末尾的输入框，按名称或别名从工作区可见标签里挑一个；已在分组里的不再列出，条数照样补足。 */
function PickTag({ lens, members, onPick, onCancel }: { lens: Lens; members: string[]; onPick: (tag: TagLabel) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const { list, ready } = useCandidateState(lens, text, undefined, LIMIT + members.length);
  const found = list.filter((c) => !members.includes(c.tag.id)).slice(0, LIMIT);
  return (
    <li className="k-group-pick">
      <Combobox
        label="挑一个统一标签"
        placeholder="标签名或别名"
        inline
        autoFocus
        value={text}
        onValueChange={setText}
        options={found.map((c) => tagOption(c, text))}
        empty={ready ? "没有匹配的标签" : undefined}
        onSelect={(option) => onPick(option.tag)}
        onKeyDown={(e) => escape(e, onCancel)}
      />
      <button type="button" className="k-icon-btn is-xs" aria-label="取消加标签" title="取消" onClick={onCancel}><X size={12} aria-hidden="true" /></button>
    </li>
  );
}

/** Reuses the formal sidebar editor and the accepted prototype's tag-chip structure.
 * Shared IDs are already query identities. Group actions never edit an image's tags. */
export function TagGroupsPane({ safe, generation, onBrowse, onError, label = "标签分组" }: Props) {
  const [found, setFound] = useState<{ key: string; safe: boolean | null; groups: CatalogGroupView[] }>({ key: "", safe: null, groups: [] });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const view = JSON.stringify([safe, generation]);
  const key = JSON.stringify([view, refresh]);
  const current = useRef(key); current.current = key;
  // Preserve editor identity during refresh, but never display stale server labels or members.
  const groups = found.safe === safe ? found.groups : [];
  const fresh = found.key === key;
  const busy = pendingKey === key;
  const lens: Lens = { libraryId: "workspace", safe, generation, workspace: true };

  useEffect(() => {
    let alive = true;
    sharedTagGroups(UI_LANG, safe).then(
      (value) => { if (alive && current.current === key) setFound({ key, safe, groups: value ?? [] }); },
      (error) => { if (alive && current.current === key && !isLensChanged(error)) onError(String(error)); },
    );
    return () => { alive = false; };
  }, [key, safe, onError]);
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
      if (current.current === key) onError(String(error));
    } finally { setPendingKey((pending) => pending === key ? null : pending); }
  };
  const edit = (action: CatalogGroupEdit) => run(editSharedTagGroup(action, safe));
  const moved = (ids: string[], index: number, delta: number) => {
    const result = [...ids]; const other = index + delta;
    [result[index], result[other]] = [result[other], result[index]];
    return result;
  };
  const deletingGroup = groups.find((group) => group.id === deleting);
  // 每个分组一行：名称、成员数与来源，悬停或聚焦时露出操作；下面是成员标签块（设计系统 TagChip），
  // 悬停或聚焦时露出前移、后移与移出，行末是“加标签”。删除先确认（#98，design/ui-system/README.md）。
  return (
    <section ref={section} className="sidebar-tag-groups k-groups" aria-label={label} aria-busy={busy || !fresh}>
      <div className="k-groups-head">
        <span className="k-groups-count">{fresh ? `${groups.length} 个分组` : "分组"}</span>
        <button type="button" className="k-btn is-sm" aria-label="新建标签分组" title="新建分组" data-focus-key="new" disabled={busy || !fresh} onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" />新建分组</button>
      </div>
      {creating && <NewGroup onDone={(group) => {
        setCreating(false);
        remember("new");
        if (group) void run(createSharedTagGroup(group.name, group.namespace));
      }} />}
      {!fresh && <p className="k-set-note" role="status">正在更新标签分组…</p>}
      {fresh && groups.length === 0 && !creating && <p className="k-groups-empty">还没有分组。把常一起找的标签放进一个分组，标签栏就能一键查找。</p>}
      <FluidList className="k-group-list" gapClick={false}>
      {groups.map((group, index) => {
        const custom = group.namespace === null;
        const meta = custom ? `${group.tags.length} 个标签` : KINDS.find((k) => k.value === group.namespace)?.label;
        const origin = group.sources?.length ? group.sources.map((source) => `${source.libraryName} / ${source.groupName}`).join("；") : null;
        const ids = group.tags.map((t) => t.tag.id);
        return <div key={group.id} role="group" aria-label={fresh ? group.name : undefined} className="k-group">
          {renaming === group.id ? <div className="k-group-row is-renaming" onKeyDown={(e) => escape(e, () => {})}>
            <Tags size={16} aria-hidden="true" className="k-group-icon" />
            <NameInput label="标签分组名称" initial={group.name} onDone={(name) => {
              setRenaming(null);
              remember(`${group.id}:rename`);
              if (name && name !== group.name) void edit({ kind: "rename", groupId: group.id, name });
            }} />
          </div> : fresh && <FluidRow index={index}>
            <div className="k-group-row">
              <button type="button" className="k-group-name" data-focus-key={`${group.id}:name`} aria-label={`${group.name}（${group.tags.length} 个标签）`}
                disabled={busy || !onBrowse || !group.tags.length} title={onBrowse && group.tags.length ? "按这个分组查找；双击改名" : "双击改名"}
                onClick={() => onBrowse?.(ids)} onDoubleClick={() => setRenaming(group.id)}>
                <Tags size={16} aria-hidden="true" className="k-group-icon" />
                <span className="k-group-label">{group.name}</span>
                <span className="k-group-meta">{meta}</span>
                {origin && <span className="k-group-origin" title={`来自：${origin}`}>来自 {origin}</span>}
              </button>
              <span className="k-group-acts">
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:rename`} aria-label={`改名标签分组“${group.name}”`} title="改名" disabled={busy} onClick={() => setRenaming(group.id)}><PenLine size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:up`} aria-label={`上移标签分组“${group.name}”`} title="上移" disabled={busy || index === 0}
                  onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, -1) })}><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm" data-focus-key={`${group.id}:down`} aria-label={`下移标签分组“${group.name}”`} title="下移" disabled={busy || index === groups.length - 1}
                  onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, 1) })}><ArrowDown size={14} aria-hidden="true" /></button>
                <button type="button" className="k-icon-btn is-sm is-danger" data-focus-key={`${group.id}:delete`} aria-label={`删除标签分组“${group.name}”`} disabled={busy}
                  title="删除分组" onClick={() => setDeleting(group.id)}><Trash2 size={14} aria-hidden="true" /></button>
              </span>
            </div>
          </FluidRow>}
          {((fresh && (group.tags.length > 0 || custom)) || picking === group.id) && <ul className="k-group-members">
            {fresh && group.tags.map(({ tag, count }, memberIndex) => {
              const name = tagName(tag);
              return <li key={tag.id} className="k-group-member">
                <button type="button" className="k-group-chip" data-focus-key={`${group.id}:${tag.id}:chip`} aria-label={`${name}（${count} 张）`} disabled={!onBrowse}
                  onClick={() => onBrowse?.([tag.id])}>
                  <span className="k-group-chip-name">{name}<TagMarks tag={tag} /></span><span className="k-group-chip-count">{count}</span>
                </button>
                {custom && <span className="k-group-member-acts">
                  <button type="button" className="k-icon-btn is-xs" data-focus-key={`${group.id}:${tag.id}:prev`} aria-label={`把“${name}”在“${group.name}”中前移`} title="前移" disabled={busy || memberIndex === 0}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, -1) })}><ArrowLeft size={12} aria-hidden="true" /></button>
                  <button type="button" className="k-icon-btn is-xs" data-focus-key={`${group.id}:${tag.id}:next`} aria-label={`把“${name}”在“${group.name}”中后移`} title="后移" disabled={busy || memberIndex === group.tags.length - 1}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(ids, memberIndex, 1) })}><ArrowRight size={12} aria-hidden="true" /></button>
                  <button type="button" className="k-icon-btn is-xs" data-focus-key={`${group.id}:${tag.id}:remove`} aria-label={`把“${name}”移出“${group.name}”`} title="移出分组" disabled={busy}
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
              <button type="button" className="k-group-add" data-focus-key={`${group.id}:add`} aria-label={`给“${group.name}”加标签`} disabled={busy} onClick={() => setPicking(group.id)}>
                <Plus size={14} aria-hidden="true" />加标签</button>
            </li>}
          </ul>}
        </div>;
      })}
      </FluidList>
      <AlertDialog.Root open={!!deletingGroup} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="k-backdrop" />
          <AlertDialog.Popup className="k-dialog is-alert">
            <AlertDialog.Title className="k-dialog-title">删除分组</AlertDialog.Title>
            <AlertDialog.Description className="k-dialog-desc">「{deletingGroup?.name}」会被删除，图片的标签不变。</AlertDialog.Description>
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <AlertDialog.Close className="k-btn">取消</AlertDialog.Close>
              <button type="button" className="k-btn is-danger" onClick={() => {
                const id = deleting!; setDeleting(null);
                // 删掉的分组没有可回的位置：回到相邻分组，没有时回到“新建分组”。
                const at = groups.findIndex((g) => g.id === id), next = groups[at + 1] ?? groups[at - 1];
                restore.current = next ? `${next.id}:name` : "new";
                void edit({ kind: "delete", groupId: id });
              }}>删除</button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

/** The same application configuration editor is available without a current library. */
export function SharedTagGroupsSettings({ onError }: { onError: (message: string) => void }) {
  const [safe, setSafe] = useState<boolean | null>(null);
  const [generation, setGeneration] = useState(0);
  const modeRevision = useRef(0);
  const workspaceRevision = useRef<string | null>(null);
  const workspaceEvent = useRef(0);
  useEffect(() => {
    let alive = true; const revision = modeRevision.current;
    const baseline = async (on: boolean, mode: number) => {
      const event = workspaceEvent.current;
      try {
        const status = await workspaceStatus(on);
        if (alive && modeRevision.current === mode && workspaceEvent.current === event) workspaceRevision.current = status?.revision ?? null;
      } catch (error) {
        if (alive && modeRevision.current === mode && !isLensChanged(error)) onError(String(error));
      }
    };
    void safeMode().then(async (value) => {
      if (!alive || modeRevision.current !== revision || typeof value !== "boolean") return;
      // Establish the monitor revision before exposing editable drafts, and the actual saved safety mode.
      await baseline(value, revision);
      if (alive && modeRevision.current === revision) setSafe(value);
    }).catch((error) => { if (alive && modeRevision.current === revision) onError(String(error)); });
    const mode = onSafeModeSetting((on) => {
      if (!alive) return;
      modeRevision.current++; setSafe(on); setGeneration((n) => n + 1);
      void baseline(on, modeRevision.current);
    });
    const workspace = onWorkspaceChanged((status) => {
      if (!alive) return;
      workspaceEvent.current++;
      if (workspaceRevision.current === status.revision) return;
      workspaceRevision.current = status.revision; setGeneration((n) => n + 1);
    });
    return () => { alive = false; for (const stop of [mode, workspace]) void stop.then((unlisten) => unlisten()).catch(() => {}); };
  }, [onError]);
  return <>
    <p className="k-set-note">各图库共用；改分组不改图片标签。</p>
    {safe === null ? <p role="status">正在读取分组设置…</p> : <TagGroupsPane label="全局标签分组" safe={safe} generation={generation} onError={onError} />}
  </>;
}
