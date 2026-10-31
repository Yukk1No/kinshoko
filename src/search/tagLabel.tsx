import type { ReactNode } from "react";
import type { RatingLabel } from "../bindings/RatingLabel";
import type { TagLabel } from "../bindings/TagLabel";
import { Languages } from "lucide-react";
import { i18n } from "../i18n";

/** 分级不是标签：条件与候选里都带“分级”字样，和标签区分开。 */
export function RatingName({ rating }: { rating: RatingLabel }) {
  return (
    <>
      <span className="search-rating-mark">{i18n.t("search:ratingMark")}</span>
      <span>{rating.name}</span>
    </>
  );
}

export const tagName = (tag: TagLabel) => `${i18n.t(`tags:namespace.${tag.namespace}`)}${tag.name}`;

/** 未翻译标记的说明（#160）：图标的可访问名称与悬停提示。 */
export const untranslatedHint = () => i18n.t("tags:untranslated");

/**
 * 标签名后的提示：尚未翻译（翻译图标，#160），或没有外部对应、不参与内置近似对应表。
 * `untranslated`：换掉尚未翻译的标记，例如详情面板里可以点的改名按钮（#182）。
 */
export function TagMarks({ tag, untranslated }: { tag: TagLabel; untranslated?: ReactNode }) {
  return (
    <>
      {tag.untranslated && (untranslated ??
        <span className="untranslated" role="img" aria-label={untranslatedHint()} title={untranslatedHint()}>
          <Languages size={12} aria-hidden="true" />
        </span>
      )}
      {!tag.hasExternal && (
        <span
          className="no-external"
          role="img"
          aria-label={i18n.t("tags:noExternal")}
          title={i18n.t("tags:noExternal")}
        />
      )}
    </>
  );
}
