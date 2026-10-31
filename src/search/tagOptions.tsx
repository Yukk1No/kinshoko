import type { Candidate } from "../bindings/Candidate";
import type { TagLabel } from "../bindings/TagLabel";
import { Highlight, type ComboboxOption } from "../ui/Combobox";
import { tagName } from "./tagLabel";
import { i18n } from "../i18n";

export type TagOption = ComboboxOption & { tag: TagLabel };

/** 一个候选标签在 Combobox 里的一行：名称、别名、未翻译图标与张数，匹配 `query` 的字标出来。 */
export function tagOption(c: Candidate, query: string): TagOption {
  return {
    id: c.tag.id,
    tag: c.tag,
    label: <Highlight text={tagName(c.tag)} query={query} />,
    via: c.via ? <>{i18n.t("search:tagVia")} <Highlight text={c.via} query={query} /></> : undefined,
    untranslated: c.tag.untranslated,
    meta: c.count,
  };
}
