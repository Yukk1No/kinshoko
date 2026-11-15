import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TagLabel } from "../bindings/TagLabel";
import type { VocabularyTag } from "../bindings/VocabularyTag";
import { addTagAlias, removeTagAlias, vocabulary } from "../ipc";
import { tagName } from "../search/SearchBox";
import { useUiLang } from "../i18n";
import { isComposingKey } from "../ui/composing";
import { X } from "lucide-react";
import { Tip } from "../ui/Tip";

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
  const [entry, setEntry] = useState<VocabularyTag | null>(null);
  const [draft, setDraft] = useState("");
  const name = tagName(tag);

  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): 词表代次前进时重读
  useEffect(() => {
    let alive = true;
    vocabulary(libraryId).then(
      (v) => alive && setEntry(v.tags.find((t) => t.id === tag.id) ?? null),
      (e) => alive && onError(e),
    );
    return () => {
      alive = false;
    };
  }, [libraryId, tag.id, generation, onError]);

  const add = () => {
    const alias = draft.trim();
    if (!alias) return;
    setDraft("");
    addTagAlias(libraryId, tag.id, { name: alias, lang }).catch((e) => onError(e));
  };

  return (
    <div className="tag-alias-editor k-tag-alias" role="dialog" aria-label={t("panel.aliasesLabel", { name })}>
      <p className="k-tag-alias-title">{t("panel.aliasesLabel", { name })}</p>
      {entry && entry.aliases.length > 0 ? (
        <ul className="tag-aliases k-tag-chips">
          {entry.aliases.map((a) => (
            <li key={a.name}>
              <span>{a.name}</span>
              <Tip label={t("alias.removeTitle")}>
                <button
                  type="button"
                  className="k-icon-btn is-xs"
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
