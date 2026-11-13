import { useState } from "react";
import { Tags, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent } from "react";
import { i18n } from "../i18n";
import { isComposingKey } from "../ui/composing";
import { Combobox } from "../ui/Combobox";
import { Select, type SelectOption } from "../ui/Select";
import { tagOption } from "../search/tagOptions";
import type { TagLabel } from "../bindings/TagLabel";
import type { TagNamespace } from "../bindings/TagNamespace";
import { LIMIT, useCandidateState, type Lens } from "../search/SearchBox";
import { Tip } from "../ui/Tip";

// 标签分组页的行内编辑部件，原样从 TagGroupsPane.tsx 移出。

const KINDS: (TagNamespace | "")[] = ["", "artist", "character", "work", "general"];
export const kindLabel = (kind: TagNamespace | "") => i18n.t(`tagGroups:kind.${kind || "custom"}`);
const kindOptions = (): SelectOption<TagNamespace | "">[] => KINDS.map((value) => ({ value, label: kindLabel(value) }));

/** Esc 只收起这一行编辑，不连带关掉外面的“编辑分组”对话框。 */
export function escape(e: KeyboardEvent, done: () => void) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  done();
}

/** 新建标签分组：列表末行展开成一行，名称和分组内容（自己挑选成员，或列出一个命名空间的全部标签）。 */
export function NewGroup({
  onDone,
}: {
  onDone: (group: { name: string; namespace: TagNamespace | null } | null) => void;
}) {
  const { t } = useTranslation("tagGroups", { keyPrefix: "create" });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TagNamespace | "">("");
  const submit = () => onDone(name.trim() ? { name: name.trim(), namespace: kind || null } : null);
  return (
    <div className="k-group-new">
      <span className="k-group-icon" aria-hidden="true">
        <Tags size={16} />
      </span>
      <input
        className="k-input"
        aria-label={t("nameLabel")}
        placeholder={t("namePlaceholder")}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (isComposingKey(e)) return;
          if (e.key === "Enter") submit();
          escape(e, () => onDone(null));
        }}
      />
      <Select label={t("kindLabel")} className="k-group-kind" value={kind} onChange={setKind} options={kindOptions()} />
      <button type="button" className="k-btn" onClick={() => onDone(null)}>
        <span className="k-label">{t("cancel")}</span>
      </button>
      <button type="button" className="k-btn" disabled={!name.trim()} onClick={submit}>
        <span className="k-label">{t("submit")}</span>
      </button>
    </div>
  );
}

/** “给分组加标签”：成员行末尾的输入框，按名称或别名从工作区可见标签里挑一个；已在分组里的不再列出，条数照样补足。 */
export function PickTag({
  lens,
  members,
  onPick,
  onCancel,
}: {
  lens: Lens;
  members: string[];
  onPick: (tag: TagLabel) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("tagGroups", { keyPrefix: "pick" });
  const [text, setText] = useState("");
  const { list, ready } = useCandidateState(lens, text, undefined, LIMIT + members.length);
  const found = list.filter((c) => !members.includes(c.tag.id)).slice(0, LIMIT);
  return (
    <li className="k-group-pick">
      <Combobox
        label={t("label")}
        placeholder={t("placeholder")}
        inline
        autoFocus
        value={text}
        onValueChange={setText}
        options={found.map((c) => tagOption(c, text))}
        empty={ready ? t("none") : undefined}
        onSelect={(option) => onPick(option.tag)}
        onKeyDown={(e) => escape(e, onCancel)}
      />
      <Tip label={t("cancelTitle")} keys="Esc">
        <button type="button" className="k-icon-btn is-xs" aria-label={t("cancelLabel")} onClick={onCancel}>
          <X size={12} aria-hidden="true" />
        </button>
      </Tip>
    </li>
  );
}
