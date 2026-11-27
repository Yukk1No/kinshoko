import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TagLabel } from "../bindings/TagLabel";
import type { Vocabulary } from "../bindings/Vocabulary";
import { addTagAlias, isLensChanged, removeTagAlias, vocabulary, tagNameConflictTags } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import type { CatalogTag } from "../bindings/CatalogTag";
import { nameConflict } from "../tags/nameConflict";
import { NameConflictWarning } from "../tags/NameConflictWarning";
import { tagName } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { isComposingKey } from "../ui/composing";
import { X } from "lucide-react";
import { Tip } from "../ui/Tip";

/** 别名编辑器的词表镜像（#780）：按资料库与标签建键，共用读取、过期重试与代次防乱序。 */
const aliasVocabularyMirror = createBackendMirror<string, Vocabulary>({
  read: (key) => {
    const [libraryId] = JSON.parse(key) as [string, string];
    return vocabulary(libraryId);
  },
  stale: isLensChanged,
});
/** 重名对照的镜像：读取失败按原样忽略（编辑别名时它只是提示）。 */
const nameConflictMirror = createBackendMirror<string, CatalogTag[]>({
  read: (key) => {
    const [libraryId, tagId] = JSON.parse(key) as [string, string];
    return tagNameConflictTags(libraryId, tagId);
  },
  stale: isLensChanged,
});
const aliasKey = (libraryId: string, tagId: string) => JSON.stringify([libraryId, tagId]);

/** 一个标签的别名：列出已有的，加新的叫法或去掉一个。别名随词表（vocabulary）刷新。 */
export function AliasEditor({
  libraryId,
  tag,
  generation,
  onError,
  onClose,
}: {
  libraryId: string;
  tag: TagLabel;
  generation: number;
  onError: (error: unknown) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("tags");
  const lang = useUiLang();
  const [draft, setDraft] = useState("");
  const name = tagName(tag);

  // 词表与重名对照的读取收口到镜像（#780）：词表代次前进时重读。
  const key = aliasKey(libraryId, tag.id);
  const vocabularyMirror = useBackendMirror(aliasVocabularyMirror, key);
  const conflictMirror = useBackendMirror(nameConflictMirror, key);
  const refreshed = useRef({ key, generation });
  useLayoutEffect(() => {
    const before = refreshed.current;
    refreshed.current = { key, generation };
    if (before.key === key && before.generation !== generation) {
      aliasVocabularyMirror.invalidate(key);
      nameConflictMirror.invalidate(key);
    }
  }, [key, generation]);
  const entry = vocabularyMirror.value?.tags.find((v) => v.id === tag.id) ?? null;
  const others = conflictMirror.value ?? [];

  // 词表读取失败报告一次；同一份失败不重复上报。重名对照的失败按原样忽略。
  const reported = useRef<unknown>(null);
  useEffect(() => {
    if (vocabularyMirror.error === null) {
      reported.current = null;
      return;
    }
    if (reported.current === vocabularyMirror.error) return;
    reported.current = vocabularyMirror.error;
    onError(vocabularyMirror.error);
  }, [vocabularyMirror.error, onError]);

  const add = () => {
    const alias = draft.trim();
    if (!alias) return;
    const submitted = draft;
    addTagAlias(libraryId, tag.id, { name: alias, lang }).then(
      () => setDraft((current) => (current === submitted ? "" : current)),
      (e) => onError(e),
    );
  };

  return (
    <div className="tag-alias-editor k-tag-alias" role="dialog" aria-label={t("panel.aliasesLabel", { name })}>
      <p className="k-section-label">{t("panel.aliasesLabel", { name })}</p>
      {entry && entry.aliases.length > 0 ? (
        <ul className="tag-aliases k-tag-chips">
          {entry.aliases.map((a) => (
            <li key={a.name} className="k-token is-24 is-square is-paper is-alias-editor">
              <span>{a.name}</span>
              <Tip label={t("alias.removeTitle")}>
                <button
                  type="button"
                  className="k-token-action is-20 is-editor-action"
                  aria-label={t("alias.removeLabel", { name: a.name })}
                  onClick={() => removeTagAlias(libraryId, tag.id, a.name).catch((e) => onError(e))}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="selection-hint">{t("alias.none")}</p>
      )}
      <input
        className="k-input"
        placeholder={t("alias.placeholder")}
        aria-label={t("alias.placeholder")}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === "Enter") add();
          if (e.key === "Escape") onClose();
        }}
      />
      <NameConflictWarning tag={nameConflict(others, { namespace: tag.namespace }, draft)} lang={lang} />
      <span className="k-tag-alias-acts">
        <button type="button" className="k-btn is-sm" onClick={onClose}>
          <span className="k-label">{t("alias.done")}</span>
        </button>
        <button type="button" className="k-btn is-sm is-primary" disabled={!draft.trim()} onClick={add}>
          <span className="k-label">{t("alias.add")}</span>
        </button>
      </span>
    </div>
  );
}
