import type { SimilarTag } from "../bindings/SimilarTag";
import type { TagLabel } from "../bindings/TagLabel";
import type { Term } from "../bindings/Term";
import { RatingName, TagMarks, tagName } from "./tagLabel";
import { i18n } from "../i18n";
import { useTranslation } from "react-i18next";

/** 文字项也匹配的标签与分级，鼠标悬停时显示，画师能看见文字查到了什么。 */
function termTitle(term: Term) {
  if (term.kind !== "text") return undefined;
  const lines = [
    term.tags.length > 0 && i18n.t("search:alsoTags", { tags: term.tags.map(tagName).join(i18n.t("search:listSeparator")) }),
    term.ratings.length > 0 && i18n.t("search:alsoRatings", { ratings: term.ratings.map((r) => r.name).join(i18n.t("search:listSeparator")) }),
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** 这一项只有一个标签时是它：“＋”加的相近标签以它为另一端。分级项没有。 */
export function soleTag(term: Term): TagLabel | null {
  if (term.kind === "tag") return term.tag;
  if (term.kind === "rating") return null;
  return term.tags.length === 1 ? term.tags[0] : null;
}

/** 条件里的一项，及其展开的相近标签。 */
export function TermView({
  term,
  showSource,
  personal = true,
  onDismiss,
  onAdd,
}: {
  term: Term;
  showSource: boolean;
  personal?: boolean;
  onDismiss: (similar: SimilarTag) => void;
  onAdd: (to: TagLabel) => void;
}) {
  const { t } = useTranslation("search");
  const sole = soleTag(term);
  if (term.kind === "rating") return <RatingName rating={term.rating} />;
  return (
    <>
      {term.kind === "tag" ? (
        <>
          <span>{tagName(term.tag)}</span>
          <TagMarks tag={term.tag} />
        </>
      ) : (
        <span title={termTitle(term)}>{t("quoted", { text: term.text })}</span>
      )}
      {term.similar.length > 0 && (
        <span className="search-similar">
          <span className="search-chip-or">{t("similar.or")}</span>
          {term.similar.map((s, k) => (
            <span key={s.tag.id} className="search-similar-tag">
              {k > 0 && t("listSeparator")}
              <span>{tagName(s.tag)}</span>
              <TagMarks tag={s.tag} />
              {showSource && (
                <span className="search-similar-source">{s.source === "builtin" ? t("similar.builtin") : t("similar.personal")}</span>
              )}
              <button type="button" aria-label={t("similar.dismissLabel", { name: tagName(s.tag) })} onClick={() => onDismiss(s)}>
                ×
              </button>
            </span>
          ))}
        </span>
      )}
      {sole && personal && (
        <button type="button" aria-label={t("similar.addLabel", { name: tagName(sole) })} onClick={() => onAdd(sole)}>
          {t("similar.addGlyph")}
        </button>
      )}
    </>
  );
}
