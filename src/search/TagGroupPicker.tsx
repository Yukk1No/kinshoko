// 标签分组（#607，design/ui-system/main-window-material.md“顶栏”）：查找框尾部的图标按钮，点开挂在查找框下面的面板，
// 所有分组的标签一次摆出来，可以跨分组连选，面板不关。条件的手势沿用原型的分组条（bd8aea4 TagGroupBar.tsx）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format";
import { Popover } from "@base-ui/react/popover";
import { PenLine, Tags } from "lucide-react";
import { Tip } from "../ui/Tip";
import { EmptyState } from "../ui/EmptyState";
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
  /** 面板底部的“编辑分组”（#98）：打开分组编辑器。 */
  onEdit?: () => void;
};

export function TagGroupPicker(p: Props) {
  const { t } = useTranslation("search");
  const [found, setFound] = useState<{ lens: string; groups: TagGroupView[] }>({ lens: "", groups: [] });
  const lang = useUiLang();
  // A new generation refreshes the same lens, so the old groups stay up (and the popover open) until the
  // new ones arrive. Any other change is a different lens: nothing from the old one may stay on screen.
  const lens = JSON.stringify([p.libraryId, p.safe, p.workspace, lang]);
  const key = JSON.stringify([lens, p.generation]);
  const current = useRef(key);
  current.current = key;
  const groups = found.lens === lens ? found.groups : [];
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (p.workspace ? workspaceTagGroups(p.libraryId, lang, p.safe) : tagGroups(p.libraryId, lang)).then(
      (next) => {
        if (alive && current.current === key) setFound({ lens, groups: next });
      },
      (error) => {
        if (alive && current.current === key && !isLensChanged(error)) p.onError(error);
      },
    );
    return () => {
      alive = false;
    };
  }, [key, lens, p.libraryId, p.safe, p.onError, p.workspace, lang]);
  const used = (id: string) => p.input.conditions.find((c) => c.any.some((t) => t.kind === "tag" && t.id === id));
  const without = (id: string) =>
    p.input.conditions.flatMap((c) => {
      const any = c.any.filter((t) => t.kind !== "tag" || t.id !== id);
      return any.length ? [{ ...c, any }] : [];
    });
  // “任一成员”加的条件：不排除，恰好是这一组的全部标签。再点一次就去掉它，不再叠一条一样的。
  // 按去重后的标签比较：同一标签在条件里出现两次时，不能冒充别的成员。
  const isAny = (g: TagGroupView) => (c: SearchInput["conditions"][number]) => {
    if (c.negate || !c.any.every((t) => t.kind === "tag")) return false;
    const ids = new Set(c.any.map((t) => (t.kind === "tag" ? t.id : "")));
    return ids.size === g.tags.length && g.tags.every(({ tag }) => ids.has(tag.id));
  };
  const remove = (id: string) => p.onChange({ ...p.input, conditions: without(id) });
  const add = (id: string, mode: "and" | "or", negate = false) => {
    const conditions = without(id);
    const term = { kind: "tag" as const, id, dismissed: [] };
    const last = conditions.at(-1);
    if (mode === "or" && last && !last.negate)
      conditions[conditions.length - 1] = { ...last, any: [...last.any, term] };
    else conditions.push({ any: [term], negate });
    p.onChange({ ...p.input, conditions });
  };
  const anyOf = (g: TagGroupView) =>
    p.onChange({
      ...p.input,
      conditions: p.input.conditions.some(isAny(g))
        ? p.input.conditions.filter((c) => !isAny(g)(c))
        : [
            ...p.input.conditions,
            { any: g.tags.map(({ tag }) => ({ kind: "tag" as const, id: tag.id, dismissed: [] })), negate: false },
          ],
    });
  return (
    <Popover.Root key={lens}>
      <Tip label={t("groups.label")}>
        <Popover.Trigger ref={trigger} className="k-groups-btn" aria-label={t("groups.label")}>
          <Tags size={16} aria-hidden="true" />
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Positioner
          className="k-positioner"
          side="bottom"
          align="start"
          sideOffset={8}
          // 挂在整个查找框下面、与它同宽，查找框与面板看起来是一件东西。
          anchor={() => trigger.current?.closest<HTMLElement>(".search") ?? trigger.current}
        >
          {/* 打开时焦点落在面板本身，不落在第一个“任一成员”上。 */}
          <Popover.Popup
            ref={popup}
            initialFocus={popup}
            className="k-popup k-groups-pop"
            aria-label={t("groups.label")}
          >
            <div className="k-groups-list">
              {groups.map((g) => (
                <section key={g.id} className="k-groups-section" aria-label={t("groups.tags", { name: g.name })}>
                  <header>
                    <h3 className="k-section-label">{g.name}</h3>
                    <button
                      type="button"
                      className="group-any"
                      aria-label={t("groups.anyLabel", { name: g.name })}
                      disabled={!g.tags.length}
                      aria-pressed={p.input.conditions.some(isAny(g))}
                      onClick={() => anyOf(g)}
                    >
                      {t("groups.any")}
                    </button>
                  </header>
                  <div className="chips">
                    {g.tags.map(({ tag, count }) => {
                      const c = used(tag.id);
                      return (
                        <button
                          type="button"
                          key={tag.id}
                          className={`chip pick${c ? (c.negate ? " is-neg" : " is-on") : ""}${!count && !c ? " is-zero" : ""}`}
                          aria-pressed={!!c}
                          onClick={(e) => (c ? remove(tag.id) : add(tag.id, e.ctrlKey || e.metaKey ? "or" : "and"))}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (c?.negate) remove(tag.id);
                            else add(tag.id, "and", true);
                          }}
                        >
                          <span className="k-label">{tagName(tag)}</span>
                          <TagMarks tag={tag} />
                          <span className="count tabular k-label">{formatNumber(count)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {!groups.length && <EmptyState size="list" title={t("groups.empty")} />}
            </div>
            {p.onEdit && (
              <>
                <div className="k-sep" />
                <Popover.Close className="k-item k-groups-edit" onClick={p.onEdit}>
                  <span className="k-item-ind">
                    <PenLine size={14} aria-hidden="true" />
                  </span>
                  <span className="k-item-label">{t("groups.edit")}</span>
                </Popover.Close>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
