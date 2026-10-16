import { useEffect, useState } from "react";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import {
  addToTagGroup,
  createTagGroup,
  deleteTagGroup,
  removeFromTagGroup,
  renameTagGroup,
  tagGroups,
} from "../ipc";
import { TagMarks, UI_LANG, tagName, useCandidates, type Lens } from "../search/SearchBox";
import { NameInput } from "./SidebarPane";

type Props = {
  libraryId: string;
  /** 浏览视角：安全模式是否开启（挑标签的候选按它取得）。 */
  safe: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：重新取得分组与计数。 */
  generation: number;
  /** 按这些标签（任一）浏览图片墙。 */
  onBrowse: (tagIds: string[]) => void;
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

/** “给分组加标签”：按名称或别名从库内标签里挑一个。 */
function PickTag({ lens, onPick, onCancel }: { lens: Lens; onPick: (tag: TagLabel) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const found = useCandidates(lens, text);
  return (
    <div className="sidebar-pick-tag">
      <input
        role="combobox"
        aria-label="挑一个库内标签"
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

/**
 * 侧栏的标签分组（ADR-0003、#51）：画师整理的分组（例如发色）或一个命名空间的全部标签，列出标签
 * 与张数（只算可见的图）。点标签按它浏览，点分组名按分组中任一标签浏览；双击分组名改名。
 * 分组只影响显示，不影响查找。
 */
export function TagGroupsPane({ libraryId, safe, generation, onBrowse, onError }: Props) {
  const [groups, setGroups] = useState<TagGroupView[]>([]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lens: Lens = { libraryId, safe, generation };

  useEffect(() => {
    let alive = true;
    tagGroups(libraryId, UI_LANG).then(
      (value) => alive && setGroups(value ?? []),
      (e) => alive && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, generation, refresh, onError]);

  const run = (p: Promise<unknown>) =>
    p.then(
      () => setRefresh((n) => n + 1),
      (e) => onError(String(e)),
    );

  return (
    <section className="sidebar-tag-groups" aria-label="标签分组">
      <div className="sidebar-heading">
        <span>标签分组</span>
        <button type="button" className="sidebar-add" aria-label="新建标签分组" onClick={() => setCreating(true)}>
          ＋
        </button>
      </div>
      {creating && (
        <NewGroup
          onDone={(group) => {
            setCreating(false);
            if (group) void run(createTagGroup(libraryId, group.name, group.namespace));
          }}
        />
      )}
      {groups.map((group) => (
        <div key={group.id} role="group" aria-label={group.name} className="sidebar-tag-group">
          {renaming === group.id ? (
            <NameInput
              label="标签分组名称"
              initial={group.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== group.name) void run(renameTagGroup(libraryId, group.id, name));
              }}
            />
          ) : (
            <div className="sidebar-tag-group-head">
              <button
                type="button"
                className="sidebar-item"
                aria-label={`${group.name}（${group.tags.length} 个标签）`}
                title="按分组中任一标签浏览；双击改名"
                disabled={group.tags.length === 0}
                onClick={() => onBrowse(group.tags.map((t) => t.tag.id))}
                onDoubleClick={() => setRenaming(group.id)}
              >
                <span className="sidebar-label">{group.name}</span>
              </button>
              {group.namespace === null && (
                <button
                  type="button"
                  className="sidebar-add"
                  aria-label={`给“${group.name}”加标签`}
                  onClick={() => setPicking(group.id)}
                >
                  ＋
                </button>
              )}
              <button
                type="button"
                className="sidebar-add"
                aria-label={`删除标签分组“${group.name}”`}
                title="只删除分组，标签与标签决定不变"
                onClick={() => void run(deleteTagGroup(libraryId, group.id))}
              >
                ×
              </button>
            </div>
          )}
          {picking === group.id && (
            <PickTag
              lens={lens}
              onCancel={() => setPicking(null)}
              onPick={(tag) => {
                setPicking(null);
                void run(addToTagGroup(libraryId, group.id, [tag.id]));
              }}
            />
          )}
          <ul className="sidebar-tree">
            {group.tags.map(({ tag, count }) => {
              const name = tagName(tag);
              return (
                <li key={tag.id} className="sidebar-tag">
                  <button
                    type="button"
                    className="sidebar-item"
                    aria-label={`${name}（${count} 张）`}
                    onClick={() => onBrowse([tag.id])}
                  >
                    <span className="sidebar-label">
                      {name}
                      <TagMarks tag={tag} />
                    </span>
                    <span className="sidebar-count">{count}</span>
                  </button>
                  {group.namespace === null && (
                    <button
                      type="button"
                      className="sidebar-add"
                      aria-label={`把“${name}”移出“${group.name}”`}
                      onClick={() => void run(removeFromTagGroup(libraryId, group.id, [tag.id]))}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
