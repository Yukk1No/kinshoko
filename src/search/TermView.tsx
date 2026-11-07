import type { ReactElement, ReactNode } from "react";
import type { SimilarTag } from "../bindings/SimilarTag";
import type { TagLabel } from "../bindings/TagLabel";
import type { Term } from "../bindings/Term";
import { RatingName, TagMarks, tagName } from "./tagLabel";
import { Tip } from "../ui/Tip";

/** 文字项也匹配的标签与分级，鼠标悬停时显示，画师能看见文字查到了什么。 */
function termTitle(term: Term) {
  if (term.kind !== "text") return undefined;
  const lines = [
    term.tags.length > 0 && `也匹配标签：${term.tags.map(tagName).join("、")}`,
    term.ratings.length > 0 && `也匹配分级：${term.ratings.map((r) => r.name).join("、")}`,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

/** 这一项只有一个标签时是它：“＋”加的相近标签以它为另一端。分级项没有。 */
export function soleTag(term: Term): TagLabel | null {
  if (term.kind === "tag") return term.tag;
  if (term.kind === "rating") return null;
  return term.tags.length === 1 ? term.tags[0] : null;
}

/**
 * 条件里的一项，及其展开的相近标签。相近标签后的“×”和末尾的“＋”交给调用方包成菜单或浮层的触发器
 * （`dismiss` / `add` 收到按钮本身），弹出的东西贴着按钮。
 */
export function TermView({
  term,
  showSource,
  personal = true,
  dismiss,
  add,
}: {
  term: Term;
  showSource: boolean;
  personal?: boolean;
  dismiss: (similar: SimilarTag, button: ReactElement) => ReactNode;
  add: (to: TagLabel, button: ReactElement) => ReactNode;
}) {
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
        <Tip label={termTitle(term)}><span>“{term.text}”</span></Tip>
      )}
      {term.similar.length > 0 && (
        <span className="search-similar">
          <span className="search-chip-or">或相近：</span>
          {term.similar.map((s, k) => (
            <span key={s.tag.id} className="search-similar-tag">
              {k > 0 && "、"}
              <span>{tagName(s.tag)}</span>
              <TagMarks tag={s.tag} />
              {showSource && (
                <span className="search-similar-source">{s.source === "builtin" ? "内置" : "个人"}</span>
              )}
              {dismiss(s, <button type="button" aria-label={`不展开“${tagName(s.tag)}”`}>×</button>)}
            </span>
          ))}
        </span>
      )}
      {sole && personal && add(sole, <button type="button" aria-label={`给“${tagName(sole)}”加相近标签`}>＋</button>)}
    </>
  );
}
