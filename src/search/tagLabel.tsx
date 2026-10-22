import type { ReactNode } from "react";
import type { RatingLabel } from "../bindings/RatingLabel";
import type { TagLabel } from "../bindings/TagLabel";
import { Languages } from "lucide-react";

/** 分级不是标签：条件与候选里都带“分级”字样，和标签区分开。 */
export function RatingName({ rating }: { rating: RatingLabel }) {
  return (
    <>
      <span className="search-rating-mark">分级</span>
      <span>{rating.name}</span>
    </>
  );
}

const NAMESPACE: Record<TagLabel["namespace"], string> = {
  general: "",
  artist: "作者：",
  character: "角色：",
  work: "作品：",
};

export const tagName = (tag: TagLabel) => `${NAMESPACE[tag.namespace]}${tag.name}`;

/** 未翻译标记的说明（#160）：图标的可访问名称与悬停提示。 */
export const UNTRANSLATED_HINT = "尚无中文名，显示的是原名";

/**
 * 标签名后的提示：尚未翻译（翻译图标，#160），或没有外部对应、不参与内置近似对应表。
 * `untranslated`：换掉尚未翻译的标记，例如详情面板里可以点的改名按钮（#182）。
 */
export function TagMarks({ tag, untranslated }: { tag: TagLabel; untranslated?: ReactNode }) {
  return (
    <>
      {tag.untranslated && (untranslated ??
        <span className="untranslated" role="img" aria-label={UNTRANSLATED_HINT} title={UNTRANSLATED_HINT}>
          <Languages size={12} aria-hidden="true" />
        </span>
      )}
      {!tag.hasExternal && (
        <span
          className="no-external"
          role="img"
          aria-label="没有外部对应，不参与内置近似对应表"
          title="没有外部对应，不参与内置近似对应表"
        />
      )}
    </>
  );
}
