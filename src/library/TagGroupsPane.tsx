import { useEffect, useRef, useState } from "react";
import type { CatalogGroupView } from "../bindings/CatalogGroupView";
import type { CatalogGroupEdit } from "../bindings/CatalogGroupEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import { createSharedTagGroup, editSharedTagGroup, sharedTagGroups, onSafeModeSetting, onWorkspaceChanged, safeMode } from "../ipc";
import { TagMarks, UI_LANG, tagName, useCandidates, type Lens } from "../search/SearchBox";
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

const KINDS: { value: TagNamespace | ""; label: string }[] = [
  { value: "", label: "自己挑选的标签" },
  { value: "artist", label: "全部作者" },
  { value: "character", label: "全部角色" },
  { value: "work", label: "全部作品" },
  { value: "general", label: "全部一般标签" },
];

/** 新建标签分组：名称，以及自己挑选成员还是列出一个命名空间的全部标签。 */
function NewGroup({ onDone }: { onDone: (group: { name: string; namespace: TagNamespace | null } | null) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TagNamespace | "">("");
  const submit = () => onDone(name.trim() ? { name: name.trim(), namespace: kind || null } : null);
  return (
    <div className="sidebar-new-group">
      <input
        className="sidebar-name-input"
        aria-label="新标签分组名称"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onDone(null);
        }}
      />
      <select aria-label="分组内容" value={kind} onChange={(e) => setKind(e.target.value as TagNamespace | "")}>
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <button type="button" disabled={!name.trim()} onClick={submit}>
        建立
      </button>
      <button type="button" onClick={() => onDone(null)}>
        取消
      </button>
    </div>
  );
}

/** “给分组加标签”：按名称或别名从工作区可见标签里挑一个。 */
function PickTag({ lens, onPick, onCancel }: { lens: Lens; onPick: (tag: TagLabel) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const found = useCandidates(lens, text);
  return (
    <div className="sidebar-pick-tag">
      <input
        role="combobox"
        aria-label="挑一个统一标签"
        aria-expanded={found.length > 0}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && found.length) onPick(found[0].tag);
        }}
      />
      {found.length > 0 && (
        <ul role="listbox" className="search-popover-list">
          {found.map((c) => (
            <li key={c.tag.id} role="option" aria-selected={false} onClick={() => onPick(c.tag)}>
              <span>{tagName(c.tag)}</span>
              <TagMarks tag={c.tag} />
              {c.via && <span className="search-candidate-via">又名：{c.via}</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

/** Reuses the formal sidebar editor and the accepted prototype's tag-chip structure.
 * Shared IDs are already query identities. Group actions never edit an image's tags. */
export function TagGroupsPane({ safe, generation, onBrowse, onError, label = "标签分组" }: Props) {
  const [found, setFound] = useState<{ key: string; view: string; groups: CatalogGroupView[] }>({ key: "", view: "", groups: [] });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const view = JSON.stringify([safe, generation]);
  const key = JSON.stringify([view, refresh]);
  const current = useRef(key); current.current = key;
  const groups = found.view === view ? found.groups : [];
  const busy = pendingKey === key;
  const lens: Lens = { libraryId: "workspace", safe, generation, workspace: true };

  useEffect(() => {
    let alive = true;
    sharedTagGroups(UI_LANG, safe).then(
      (value) => { if (alive && current.current === key) setFound({ key, view, groups: value ?? [] }); },
      (error) => { if (alive && current.current === key) onError(String(error)); },
    );
    return () => { alive = false; };
  }, [key, safe, onError]);
  useEffect(() => { setCreating(false); setRenaming(null); setPicking(null); }, [safe, generation]);
  const run = async (action: Promise<unknown>) => {
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
  return (
    <section className="sidebar-tag-groups" aria-label={label} aria-busy={busy}>
      <div className="sidebar-heading">
        <span>{label}</span>
        <button type="button" className="sidebar-add" aria-label="新建标签分组" disabled={busy} onClick={() => setCreating(true)}>＋</button>
      </div>
      {creating && <NewGroup onDone={(group) => {
        setCreating(false);
        if (group) void run(createSharedTagGroup(group.name, group.namespace));
      }} />}
      {groups.map((group, index) => (
        <div key={group.id} role="group" aria-label={group.name} className="sidebar-tag-group">
          {renaming === group.id ? <NameInput label="标签分组名称" initial={group.name} onDone={(name) => {
            setRenaming(null);
            if (name && name !== group.name) void edit({ kind: "rename", groupId: group.id, name });
          }} /> : <>
            <div className="sidebar-tag-group-head">
              <button type="button" className="sidebar-item" aria-label={`${group.name}（${group.tags.length} 个标签）`}
                title="按分组中任一标签查找；双击改名" disabled={busy || !onBrowse || !group.tags.length}
                onClick={() => onBrowse?.(group.tags.map((tag) => tag.tag.id))} onDoubleClick={() => setRenaming(group.id)}>
                <span className="sidebar-label">{group.name}</span>
              </button>
              <button type="button" className="sidebar-add" aria-label={`改名标签分组“${group.name}”`} disabled={busy} onClick={() => setRenaming(group.id)}>✎</button>
              <button type="button" className="sidebar-add" aria-label={`上移标签分组“${group.name}”`} disabled={busy || index === 0}
                onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, -1) })}>↑</button>
              <button type="button" className="sidebar-add" aria-label={`下移标签分组“${group.name}”`} disabled={busy || index === groups.length - 1}
                onClick={() => void edit({ kind: "orderGroups", groupIds: moved(groups.map((g) => g.id), index, 1) })}>↓</button>
              {group.namespace === null && <button type="button" className="sidebar-add" aria-label={`给“${group.name}”加标签`} disabled={busy} onClick={() => setPicking(group.id)}>＋</button>}
              <button type="button" className="sidebar-add" aria-label={`删除标签分组“${group.name}”`} disabled={busy}
                title="只删除分组，图片标签不变" onClick={() => void edit({ kind: "delete", groupId: group.id })}>×</button>
            </div>
          </>}
          {!!group.sources?.length && <p className="tag-group-origin">来自：{group.sources.map((source) => `${source.libraryName} / ${source.groupName}`).join("；")}</p>}
          {picking === group.id && <PickTag lens={lens} onCancel={() => setPicking(null)} onPick={(tag) => {
            setPicking(null); void edit({ kind: "addMembers", groupId: group.id, tagIds: [tag.id] });
          }} />}
          <ul className="sidebar-tree">
            {group.tags.map(({ tag, count }, memberIndex) => {
              const name = tagName(tag);
              return <li key={tag.id} className="sidebar-tag">
                <button type="button" className="sidebar-item" aria-label={`${name}（${count} 张）`} disabled={!onBrowse}
                  onClick={() => onBrowse?.([tag.id])}>
                  <span className="sidebar-label">{name}<TagMarks tag={tag} /></span><span className="sidebar-count">{count}</span>
                </button>
                {group.namespace === null && <>
                  <button type="button" className="sidebar-add" aria-label={`上移“${name}”在“${group.name}”中的顺序`} disabled={busy || memberIndex === 0}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(group.tags.map((t) => t.tag.id), memberIndex, -1) })}>↑</button>
                  <button type="button" className="sidebar-add" aria-label={`下移“${name}”在“${group.name}”中的顺序`} disabled={busy || memberIndex === group.tags.length - 1}
                    onClick={() => void edit({ kind: "orderMembers", groupId: group.id, tagIds: moved(group.tags.map((t) => t.tag.id), memberIndex, 1) })}>↓</button>
                  <button type="button" className="sidebar-add" aria-label={`把“${name}”移出“${group.name}”`} disabled={busy}
                    onClick={() => void edit({ kind: "removeMembers", groupId: group.id, tagIds: [tag.id] })}>×</button>
                </>}
              </li>;
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The same application configuration editor is available without a current library. */
export function SharedTagGroupsSettings({ onError }: { onError: (message: string) => void }) {
  const [safe, setSafe] = useState(true);
  const [generation, setGeneration] = useState(0);
  const modeRevision = useRef(0);
  useEffect(() => {
    let alive = true; const revision = modeRevision.current;
    void safeMode().then((value) => { if (alive && modeRevision.current === revision && typeof value === "boolean") setSafe(value); }).catch((error) => alive && onError(String(error)));
    const mode = onSafeModeSetting((on) => { if (alive) { modeRevision.current++; setSafe(on); setGeneration((n) => n + 1); } });
    const workspace = onWorkspaceChanged(() => { if (alive) setGeneration((n) => n + 1); });
    return () => { alive = false; for (const stop of [mode, workspace]) void stop.then((unlisten) => unlisten()).catch(() => {}); };
  }, [onError]);
  return <>
    <h2>全局标签分组</h2>
    <p className="settings-hint">分组在各资料库共用。按分组查找表示满足任一成员，图片标签保持原样。同名旧分组分别保留，并列出原资料库。</p>
    <TagGroupsPane label="全局标签分组" safe={safe} generation={generation} onError={onError} />
  </>;
}
