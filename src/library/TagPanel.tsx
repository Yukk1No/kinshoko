import { useEffect, useRef, useState } from "react";
import type { ResolvedTagIdentity } from "../bindings/ResolvedTagIdentity";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { ImageTag } from "../bindings/ImageTag";
import type { TagRef } from "../bindings/TagRef";
import type { VocabularyTag } from "../bindings/VocabularyTag";
import { addTagAlias, catalogImageTags, editTags, imageTags, removeTagAlias, vocabulary, workspaceSourceInspection, workspaceEditSourceTags } from "../ipc";
import { TagMarks, UI_LANG, tagName, useCandidates } from "../search/SearchBox";
import { TagChip } from "../tags/TagChip";
import { tagStanding } from "../tags/tagConfidence";
import { useTagDisplay } from "../tags/TagDisplayContext";
import { AtSign, Ban, Check, Tags, Undo2, X } from "lucide-react";

type Props = {
  sourceTarget?: import("../bindings/WorkspaceSourceTarget").WorkspaceSourceTarget;
  libraryId: string;
  /** 选中的参考图；只有一张时列出它的标签。 */
  ids: string[];
  /** 浏览视角：安全模式是否开启（候选按它取得）。 */
  safe: boolean;
  /** 词表代次（词表、图片或安全模式变化时递增）：重新取得标签、别名与候选。 */
  generation: number;
  onError: (message: string) => void;
};

const NAMESPACES: { value: TagNamespace; label: string }[] = [
  { value: "general", label: "一般" },
  { value: "artist", label: "作者" },
  { value: "character", label: "角色" },
  { value: "work", label: "作品" },
];

type Group = { label: string; title: string; tags: ImageTag[] };

/** C 风格的分组：你添加的 / 打标模型（按可信度从高到低，没有分数的在后）/ 导入；空组不列。 */
function groupByStanding(tags: ImageTag[]): Group[] {
  const groups: Group[] = [
    { label: "你添加的", title: "你添加的", tags: [] },
    { label: "打标模型", title: "打标模型 · 按可信度", tags: [] },
    { label: "导入", title: "导入", tags: [] },
  ];
  const scoreOf = new Map<ImageTag, number>();
  for (const entry of tags) {
    const standing = tagStanding(entry.origins);
    if (standing.kind === "model") scoreOf.set(entry, standing.score ?? -1);
    groups[standing.kind === "manual" ? 0 : standing.kind === "model" ? 1 : 2].tags.push(entry);
  }
  groups[1].tags.sort((a, b) => scoreOf.get(b)! - scoreOf.get(a)!);
  return groups.filter((group) => group.tags.length > 0);
}

const byId = (tag: TagLabel): TagRef => ({ kind: "id", id: tag.id });

/**
 * 选中参考图的标签（#51）：只选一张时列出有效标签及出处、被否决的标签，可以确认、否决或清除
 * 人工标签决定，给标签加别名；选几张都能按命名空间与名称（或别名）一次添加、否决或清除。
 * 人工标签决定优先于来源事实，重新打标或重新迁入不会覆盖。
 */
export function TagPanel({ libraryId, ids, safe, generation, onError, sourceTarget }: Props) {
  const single = ids.length === 1 ? ids[0] : null;
  const [identities, setIdentities] = useState<ResolvedTagIdentity[]>([]);
  const [tags, setTags] = useState<ImageTags | null>(null);
  const [aliasFor, setAliasFor] = useState<TagLabel | null>(null);
  const [namespace, setNamespace] = useState<TagNamespace>("general");
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState(0);
  const display = useTagDisplay();
  const candidates = useCandidates({ libraryId, safe, generation, sourceTarget }, text);
  const identityKey = JSON.stringify([libraryId, ids, safe, generation, sourceTarget]);
  const currentKey = useRef(identityKey);
  currentKey.current = identityKey;
  useEffect(() => { currentKey.current = identityKey; return () => { currentKey.current = ""; }; }, [identityKey]);

  useEffect(() => {
    let alive = true;
    if (!single) {
      setTags(null);
      setIdentities([]);
      return;
    }
    setIdentities([]);
    setTags(null);
    if (sourceTarget) {
      workspaceSourceInspection(sourceTarget, safe, UI_LANG).then(
        (value) => { if (alive) { setTags(value.tags.image); setIdentities(value.tags.identities); } },
        (error) => alive && onError(String(error)),
      );
      return () => { alive = false; };
    }
    catalogImageTags(libraryId, single, UI_LANG).then(
      (value) => alive && setIdentities(value?.identities ?? []),
      (error) => alive && onError(String(error)),
    );
    imageTags(libraryId, single, UI_LANG).then(
      (value) => alive && setTags(value),
      (e) => alive && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, single, safe, generation, refresh, onError, identityKey]);

  // 换了选中的图，别名编辑跟着关掉。
  useEffect(() => setAliasFor(null), [single]);

  const edit = (edits: TagEdit[]) =>
    (sourceTarget ? workspaceEditSourceTags(sourceTarget, safe, edits) : editTags(libraryId, ids, edits)).then(
      () => { if (currentKey.current === identityKey) setRefresh((n) => n + 1); },
      (e) => { if (currentKey.current === identityKey) onError(String(e)); },
    );

  const typed = (): TagRef | null => {
    const name = text.trim();
    return name ? { kind: "named", namespace, name, lang: UI_LANG } : null;
  };
  const decide = (kind: TagEdit["kind"], tag: TagRef | null = typed()) => {
    if (!tag) return;
    setText("");
    void edit([{ kind, tag }]);
  };

  const hasText = !!text.trim();
  const lowOutline = display.lowOutline ? "" : undefined;
  const chip = ({ tag, origins }: ImageTag, meter: boolean) => {
    const manual = origins.some((o) => o.kind === "manual");
    const name = tagName(tag);
    const unified = identities.filter((identity) => identity.localTagId === tag.id);
    return (
      <TagChip key={tag.id} tag={tag} origins={origins} meter={meter}
        notes={unified.map((identity) => `统一为：${tagName(identity.tag)}`)}
        actions={<>
          {manual ? (
            <button type="button" className="k-tag-tip-btn" aria-label={`清除对“${name}”的人工决定`}
              onClick={() => decide("clear", byId(tag))}><Undo2 size={12} aria-hidden="true" />改回自动</button>
          ) : (
            <button type="button" className="k-tag-tip-btn" aria-label={`确认“${name}”`} title="重新打标也不去掉"
              onClick={() => decide("add", byId(tag))}><Check size={12} aria-hidden="true" />保留</button>
          )}
          <button type="button" className="k-tag-tip-btn" aria-label={`否决“${name}”`} title="这张图不是它"
            onClick={() => decide("reject", byId(tag))}><Ban size={12} aria-hidden="true" />不要</button>
          {!sourceTarget && <button type="button" className="k-tag-tip-btn" aria-label={`“${name}”的别名`}
            onClick={() => setAliasFor(tag)}><AtSign size={12} aria-hidden="true" />别名</button>}
        </>} />
    );
  };
  // 详情面板的标签（#98，design/ui-system/README.md 与 copy-map.md；#160）：现有标签是小标签，只写名称；
  // 出处、可信度和“保留／改回自动／不要／别名”在悬停或聚焦时的浮层里。外观按设置：B 按可信度分档底色，
  // C 按出处分组加刻度。输入框一个，打字后才出现“添加／排除／改回自动”。
  return (
    <section className="tag-panel insp-sec k-tags" aria-label="标签">
      <h4><Tags size={13} aria-hidden="true" />标签</h4>
      {tags && (
        <>
          {display.style === "grouped" && tags.tags.length > 0
            ? groupByStanding(tags.tags).map((group) => (
              <div key={group.label} className="k-tag-group">
                <p className="k-tags-sub">{group.title}</p>
                <ul className="tag-list k-tag-chips" aria-label={group.label} data-low-outline={lowOutline}>
                  {group.tags.map((entry) => chip(entry, group.label === "打标模型"))}
                </ul>
              </div>
            ))
            : <ul className="tag-list k-tag-chips" aria-label="有效标签" data-low-outline={lowOutline}>
              {tags.tags.length === 0 && <li className="tag-empty k-tags-empty">还没有标签</li>}
              {tags.tags.map((entry) => chip(entry, false))}
            </ul>}
          {tags.rejected.length > 0 && (<>
            <p className="k-tags-sub">已排除</p>
            <ul className="tag-list tag-list-rejected k-tag-chips" aria-label="已否决">
              {tags.rejected.map((tag) => {
                const name = tagName(tag);
                return (
                  <li key={tag.id} className="tag-row k-tag-chip is-rejected">
                    <span className="tag-name">{name}</span>
                    <TagMarks tag={tag} />
                    <button type="button" className="k-tag-restore" aria-label={`撤销否决“${name}”`} title="改回自动"
                      onClick={() => decide("clear", byId(tag))}>恢复</button>
                  </li>
                );
              })}
            </ul>
          </>)}
        </>
      )}
      <div className="tag-add k-tag-add">
        <div className="k-tag-field">
          <select className="k-tag-kind" aria-label="命名空间" title="标签类别" value={namespace}
            onChange={(e) => setNamespace(e.target.value as TagNamespace)}>
            {NAMESPACES.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </select>
          <input
            role="combobox"
            aria-label="标签名"
            aria-expanded={candidates.length > 0}
            placeholder="加标签…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") decide("add");
              if (e.key === "Escape") setText("");
            }}
          />
        </div>
        {candidates.length > 0 && (
          <ul role="listbox" className="search-popover-list" aria-label="库内标签">
            {candidates.map((c) => (
              <li key={c.tag.id} role="option" aria-selected={false} onClick={() => decide("add", byId(c.tag))}>
                <span>{tagName(c.tag)}</span>
                <TagMarks tag={c.tag} />
                {c.via && <span className="search-candidate-via">又名：{c.via}</span>}
              </li>
            ))}
          </ul>
        )}
        {ids.length > 1 && <p className="selection-hint insp-hint">对已选的 {ids.length} 张一起记下</p>}
        {hasText && <div className="selection-actions k-tag-add-acts">
          <button type="button" className="k-btn is-sm is-primary" aria-label="添加标签" onClick={() => decide("add")}>添加</button>
          <button type="button" className="k-btn is-sm is-ghost" aria-label="否决标签" title="这张图不是这个标签" onClick={() => decide("reject")}>排除</button>
          <button type="button" className="k-btn is-sm is-ghost" aria-label="清除标签决定" title="回到模型和导入给出的结果" onClick={() => decide("clear")}>改回自动</button>
        </div>}
      </div>
      {aliasFor && (
        <AliasEditor
          key={aliasFor.id}
          libraryId={libraryId}
          tag={aliasFor}
          generation={generation}
          onError={onError}
          onClose={() => setAliasFor(null)}
        />
      )}
    </section>
  );
}

/** 一个标签的别名：列出已有的，加新的叫法或去掉一个。别名随词表（vocabulary）刷新。 */
function AliasEditor({
  libraryId,
  tag,
  generation,
  onError,
  onClose,
}: {
  libraryId: string;
  tag: TagLabel;
  generation: number;
  onError: (message: string) => void;
  onClose: () => void;
}) {
  const [entry, setEntry] = useState<VocabularyTag | null>(null);
  const [draft, setDraft] = useState("");
  const name = tagName(tag);

  useEffect(() => {
    let alive = true;
    vocabulary(libraryId).then(
      (v) => alive && setEntry(v.tags.find((t) => t.id === tag.id) ?? null),
      (e) => alive && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, tag.id, generation, onError]);

  const add = () => {
    const alias = draft.trim();
    if (!alias) return;
    setDraft("");
    addTagAlias(libraryId, tag.id, { name: alias, lang: UI_LANG }).catch((e) => onError(String(e)));
  };

  return (
    <div className="tag-alias-editor k-tag-alias" role="dialog" aria-label={`“${name}”的别名`}>
      <p className="insp-hint">“{name}”的别名，查找和加标签时都认</p>
      {entry && entry.aliases.length > 0 ? (
        <ul className="tag-aliases k-tag-chips">
          {entry.aliases.map((a) => (
            <li key={a.name}>
              <span>{a.name}</span>
              <button
                type="button"
                className="k-icon-btn is-xs"
                aria-label={`去掉别名“${a.name}”`}
                title="去掉"
                onClick={() => removeTagAlias(libraryId, tag.id, a.name).catch((e) => onError(String(e)))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="selection-hint">还没有别名</p>
      )}
      <input
        className="k-input"
        placeholder="新的叫法"
        aria-label="新别名"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") onClose();
        }}
      />
      <span className="k-tag-alias-acts">
        <button type="button" className="k-btn is-sm" onClick={onClose}>
          完成
        </button>
        <button type="button" className="k-btn is-sm is-primary" disabled={!draft.trim()} onClick={add}>
          加别名
        </button>
      </span>
    </div>
  );
}
