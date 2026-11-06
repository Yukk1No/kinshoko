// Adapted from bd8aea4:prototype/reference-browser/src/components/TagGroupBar.tsx.
// Accepted popovers and condition gestures, backed by the formal library IPC and SearchInput.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, PenLine } from "lucide-react";
import type { TagGroupView } from "../bindings/TagGroupView";
import type { SearchInput } from "../bindings/SearchInput";
import { isLensChanged, tagGroups, workspaceTagGroups } from "../ipc";
import { TagMarks, tagName } from "./SearchBox";
import { useUiLang } from "../i18n";

type Props = {
  workspace?: boolean;
  libraryId: string;
  safe: boolean;
  generation: number;
  input: SearchInput;
  onChange: (input: SearchInput) => void;
  onError: (error: unknown) => void;
  /** 标签栏右侧的“编辑分组”（#98）：打开分组编辑器。 */
  onEdit?: () => void;
};

export function TagGroupBar(p: Props) {
  const { t } = useTranslation("search");
  const [found, setFound] = useState<{ lens: string; groups: TagGroupView[] }>({ lens: "", groups: [] });
  const lang = useUiLang();
  // A new generation refreshes the same lens, so the old groups stay up (and the popover open) until the
  // new ones arrive. Any other change is a different lens: nothing from the old one may stay on screen.
  const lens = JSON.stringify([p.libraryId, p.safe, p.workspace, lang]);
  const key = JSON.stringify([lens, p.generation]);
  const current = useRef(key); current.current = key;
  const groups = found.lens === lens ? found.groups : [];
  const [open, setOpen] = useState<string | null>(null);
  const isOpen = groups.some((g) => g.id === open);
  useEffect(() => {
    let alive = true;
    (p.workspace ? workspaceTagGroups(p.libraryId, lang, p.safe) : tagGroups(p.libraryId, lang)).then(
      (next) => { if (alive && current.current === key) setFound({ lens, groups: next ?? [] }); },
      (error) => { if (alive && current.current === key && !isLensChanged(error)) p.onError(error); },
    );
    return () => { alive = false; };
  }, [key, lens, p.libraryId, p.safe, p.onError, p.workspace, lang]);
  const used = (id: string) => p.input.conditions.find((c) => c.any.some((t) => t.kind === "tag" && t.id === id));
  const without = (id: string) => p.input.conditions.flatMap((c) => {
    const any = c.any.filter((t) => t.kind !== "tag" || t.id !== id);
    return any.length ? [{ ...c, any }] : [];
  });
  const remove = (id: string) => p.onChange({ ...p.input, conditions: without(id) });
  const add = (id: string, mode: "and" | "or", negate = false) => {
    const conditions = without(id);
    const term = { kind: "tag" as const, id, dismissed: [] };
    const last = conditions.at(-1);
    if (mode === "or" && last && !last.negate) conditions[conditions.length - 1] = { ...last, any: [...last.any, term] };
    else conditions.push({ any: [term], negate });
    p.onChange({ ...p.input, conditions });
  };
  // One popover shared by every group button: switching groups moves it and swaps its content (Popover.Viewport).
  // `open` is ahead of the payload on the first open, so the first measure sees the content; the payload
  // keeps the group while it plays its way out, when `open` is already null.
  return <Popover.Root<string> key={lens} open={isOpen}
    onOpenChange={(next, details) => setOpen(next ? details.trigger?.getAttribute("data-group") ?? null : null)}>
    {({ payload }) => {
      const g = groups.find((group) => group.id === (open ?? payload));
      return <div className="groupbar" role="toolbar" aria-label={t("groups.label")}>
        {groups.map((group) => {
          const picked = group.tags.filter(({ tag }) => used(tag.id)).length;
          return <Popover.Trigger key={group.id} className={`group-btn${picked ? " has-picked" : ""}`} data-group={group.id} payload={group.id}>
            <span className="k-label">{group.name}</span>{picked > 0 && <span className="badge tabular">{picked}</span>}<ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          </Popover.Trigger>;
        })}
        {!groups.length && <span className="groupbar-empty">{t("groups.empty")}</span>}
        {p.onEdit && <button type="button" className="groupbar-edit" onClick={p.onEdit}><PenLine size={13} aria-hidden="true" /><span className="k-label">{t("groups.edit")}</span></button>}
        <Popover.Portal>
          <Popover.Positioner className="k-positioner group-pop-positioner" side="bottom" align="start" sideOffset={6}>
            <Popover.Popup className="group-pop" aria-label={g && t("groups.tags", { name: g.name })}>
              <Popover.Viewport className="group-pop-viewport">
                {g && <>
                  <Popover.Close className="group-any" aria-label={t("groups.anyLabel", { name: g.name })} disabled={!g.tags.length}
                    onClick={() => p.onChange({ ...p.input, conditions: [...p.input.conditions, { any: g.tags.map(({ tag }) => ({ kind: "tag", id: tag.id, dismissed: [] })), negate: false }] })}>{t("groups.any")}</Popover.Close>
                  <div className="chips">
                    {g.tags.map(({ tag, count }) => {
                      const c = used(tag.id);
                      return <button type="button" key={tag.id} className={`chip pick${c ? (c.negate ? " is-neg" : " is-on") : ""}${!count && !c ? " is-zero" : ""}`}
                        aria-pressed={!!c}
                        onClick={(e) => c ? remove(tag.id) : add(tag.id, e.ctrlKey || e.metaKey ? "or" : "and")}
                        onContextMenu={(e) => { e.preventDefault(); if (c?.negate) remove(tag.id); else add(tag.id, "and", true); }}>
                        <span className="k-label">{tagName(tag)}</span><TagMarks tag={tag} /><span className="count tabular k-label">{formatNumber(count)}</span>
                      </button>;
                    })}
                  </div>
                </>}
              </Popover.Viewport>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </div>;
    }}
  </Popover.Root>;
}
