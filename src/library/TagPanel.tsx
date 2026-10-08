import { useEffect, useState } from "react";
import type { ResolvedTagIdentity } from "../bindings/ResolvedTagIdentity";
import type { ImageTags } from "../bindings/ImageTags";
import type { TagEdit } from "../bindings/TagEdit";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import type { TagOrigin } from "../bindings/TagOrigin";
import type { TagRef } from "../bindings/TagRef";
import type { VocabularyTag } from "../bindings/VocabularyTag";
import { addTagAlias, catalogImageTags, editTags, imageTags, removeTagAlias, vocabulary } from "../ipc";
import { TagMarks, UI_LANG, tagName, useCandidates } from "../search/SearchBox";

type Props = {
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

/** 出处的简短说明：模型带分数、导入来源、人工添加或决定冲突。 */
function originText(origin: TagOrigin): string {
  if (origin.kind === "manual") return "人工添加";
  if (origin.kind === "conflict") return "决定冲突";
  const { source, score } = origin;
  if (source.startsWith("model:")) return score === null ? "模型" : `模型 ${score.toFixed(2)}`;
  if (source.startsWith("eagle:")) return "Eagle";
  if (source.startsWith("package:")) return "参考组包";
  if (source === "restore") return "备份";
  return "导入";
}

const byId = (tag: TagLabel): TagRef => ({ kind: "id", id: tag.id });

/**
 * 选中参考图的标签（#51）：只选一张时列出有效标签及出处、被否决的标签，可以确认、否决或清除
 * 人工标签决定，给标签加别名；选几张都能按命名空间与名称（或别名）一次添加、否决或清除。
 * 人工标签决定优先于来源事实，重新打标或重新迁入不会覆盖。
 */
export function TagPanel({ libraryId, ids, safe, generation, onError }: Props) {
  const single = ids.length === 1 ? ids[0] : null;
  const [identities, setIdentities] = useState<ResolvedTagIdentity[]>([]);
  const [tags, setTags] = useState<ImageTags | null>(null);
  const [aliasFor, setAliasFor] = useState<TagLabel | null>(null);
  const [namespace, setNamespace] = useState<TagNamespace>("general");
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState(0);
  const candidates = useCandidates({ libraryId, safe, generation }, text);

  useEffect(() => {
    let alive = true;
    if (!single) {
      setTags(null);
      setIdentities([]);
      return;
    }
    setIdentities([]);
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
  }, [libraryId, single, generation, refresh, onError]);

  // 换了选中的图，别名编辑跟着关掉。
  useEffect(() => setAliasFor(null), [single]);

  const edit = (edits: TagEdit[]) =>
    editTags(libraryId, ids, edits).then(
      () => setRefresh((n) => n + 1),
      (e) => onError(String(e)),
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

  return (
    <section className="tag-panel" aria-label="标签">
      {tags && (
        <>
          <ul className="tag-list" aria-label="有效标签">
            {tags.tags.length === 0 && <li className="tag-empty">还没有标签</li>}
            {tags.tags.map(({ tag, origins }) => {
              const manual = origins.some((o) => o.kind === "manual");
              const name = tagName(tag);
              return (
                <li key={tag.id} className="tag-row">
                  <span className="tag-name">{name}</span>
                  <TagMarks tag={tag} />
                  {identities.filter((identity) => identity.localTagId === tag.id).map((identity) => <small key={identity.catalogId} className="tag-origin" title={`统一 ID：${identity.catalogId}`}>统一：{tagName(identity.tag)}</small>)}
                  <span className="tag-origins">
                    {origins.map((o, i) => (
                      <span key={i} className="tag-origin">
                        {originText(o)}
                      </span>
                    ))}
                  </span>
                  <span className="tag-row-actions">
                    {manual ? (
                      <button
                        type="button"
                        aria-label={`清除对“${name}”的人工决定`}
                        title="回到来源（模型、导入）决定的状态"
                        onClick={() => decide("clear", byId(tag))}
                      >
                        清除
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`确认“${name}”`}
                        title="记为人工添加：重新打标或重新迁入不会去掉"
                        onClick={() => decide("add", byId(tag))}
                      >
                        ✓
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`否决“${name}”`}
                      title="这张图没有这个标签：来源再给出也不算"
                      onClick={() => decide("reject", byId(tag))}
                    >
                      ⊘
                    </button>
                    <button type="button" aria-label={`“${name}”的别名`} onClick={() => setAliasFor(tag)}>
                      别名
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {tags.rejected.length > 0 && (
            <ul className="tag-list tag-list-rejected" aria-label="已否决">
              {tags.rejected.map((tag) => {
                const name = tagName(tag);
                return (
                  <li key={tag.id} className="tag-row">
                    <span className="tag-name">{name}</span>
                    <TagMarks tag={tag} />
                    <button
                      type="button"
                      aria-label={`撤销否决“${name}”`}
                      title="回到来源（模型、导入）决定的状态"
                      onClick={() => decide("clear", byId(tag))}
                    >
                      撤销否决
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <div className="tag-add">
        <select
          aria-label="命名空间"
          value={namespace}
          onChange={(e) => setNamespace(e.target.value as TagNamespace)}
        >
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
          placeholder="标签名或别名"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") decide("add");
            if (e.key === "Escape") setText("");
          }}
        />
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
        {ids.length > 1 && <p className="selection-hint">对已选的 {ids.length} 张一起记下决定</p>}
        <div className="selection-actions">
          <button type="button" disabled={!text.trim()} onClick={() => decide("add")}>
            添加标签
          </button>
          <button type="button" disabled={!text.trim()} onClick={() => decide("reject")}>
            否决标签
          </button>
          <button type="button" disabled={!text.trim()} onClick={() => decide("clear")}>
            清除标签决定
          </button>
        </div>
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
    <div className="tag-alias-editor" role="dialog" aria-label={`“${name}”的别名`}>
      <p>“{name}”的其他叫法，查找和添加标签时都认：</p>
      {entry && entry.aliases.length > 0 ? (
        <ul className="tag-aliases">
          {entry.aliases.map((a) => (
            <li key={a.name}>
              <span>{a.name}</span>
              <button
                type="button"
                aria-label={`去掉别名“${a.name}”`}
                onClick={() => removeTagAlias(libraryId, tag.id, a.name).catch((e) => onError(String(e)))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="selection-hint">还没有别名</p>
      )}
      <input
        aria-label="新别名"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") onClose();
        }}
      />
      <button type="button" disabled={!draft.trim()} onClick={add}>
        加别名
      </button>
      <button type="button" onClick={onClose}>
        完成
      </button>
    </div>
  );
}
