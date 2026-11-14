// 标签分组的两种新摆法（第四轮），都接在正式程序的查找条件上：选一个标签，查找框里真的多一个条件。
//   panel：分组条取消，查找框后面一个“分组”按钮，点开的面板里所有分组的标签一次摆出来，“编辑分组”在面板底部。
//   side： 分组成为左栏里的一段，用和文件夹一样的行，展开后点标签。
// 正式程序没有给原型留接口，这里从分组条的 React 节点上读它的 props（input 与 onChange）。只有原型能这么做。
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronRight, PenLine, Tags } from "lucide-react";
import { groups } from "./backend";

type Term = { kind: string; id?: string; dismissed?: string[] };
type Condition = { any: Term[]; negate: boolean };
type Input = { conditions: Condition[]; exact: boolean };
type Bar = { input: Input; onChange: (input: Input) => void };
type Group = (typeof groups)[number];

/** 正式程序的分组条收到的 props：当前的查找条件与改条件的函数。 */
function bar(): Bar | null {
  const element = document.querySelector(".groupbar") as (Element & Record<string, unknown>) | null;
  const key = element && Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  for (let fiber = key ? (element[key] as { memoizedProps?: Partial<Bar>; return?: unknown }) : null; fiber; fiber = fiber.return as typeof fiber) {
    const props = fiber.memoizedProps;
    if (props?.input?.conditions && typeof props.onChange === "function") return props as Bar;
  }
  return null;
}

/** 当前的查找条件；正式程序那边一变，这里跟着变。 */
function useSearch() {
  const [input, setInput] = useState<Input>({ conditions: [], exact: false });
  useEffect(() => {
    const read = () => { const next = bar()?.input; if (next) setInput((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); };
    read();
    const timer = setInterval(read, 150);
    return () => clearInterval(timer);
  }, []);
  const change = (conditions: Condition[]) => { const current = bar(); if (current) { current.onChange({ ...current.input, conditions }); setInput({ ...current.input, conditions }); } };
  const used = (id: string) => input.conditions.find((condition) => condition.any.some((term) => term.kind === "tag" && term.id === id));
  const without = (id: string) => input.conditions.flatMap((condition) => {
    const any = condition.any.filter((term) => term.kind !== "tag" || term.id !== id);
    return any.length ? [{ ...condition, any }] : [];
  });
  /** 与正式的分组条同样的手势：点一下加为条件，再点去掉；右键排除。 */
  const pick = (id: string) => change(used(id) ? without(id) : [...without(id), { any: [{ kind: "tag", id, dismissed: [] }], negate: false }]);
  const exclude = (id: string, event: MouseEvent) => { event.preventDefault(); change(used(id)?.negate ? without(id) : [...without(id), { any: [{ kind: "tag", id, dismissed: [] }], negate: true }]); };
  const isAny = (group: Group) => (condition: Condition) => !condition.negate && condition.any.length === group.tags.length
    && group.tags.every(({ tag }) => condition.any.some((term) => term.kind === "tag" && term.id === tag.id));
  const anyOf = (group: Group) => change(input.conditions.some(isAny(group)) ? input.conditions.filter((condition) => !isAny(group)(condition))
    : [...input.conditions, { any: group.tags.map(({ tag }) => ({ kind: "tag", id: tag.id, dismissed: [] })), negate: false }]);
  const picked = (group: Group) => group.tags.filter(({ tag }) => used(tag.id)).length;
  return { input, used, pick, exclude, isAny, anyOf, picked };
}

/** 打开正式程序的“编辑分组”对话框：点它藏起来的那个按钮。 */
const editGroups = () => document.querySelector<HTMLButtonElement>(".groupbar-edit")?.click();

function GroupsPanel() {
  const search = useSearch();
  const total = groups.reduce((sum, group) => sum + search.picked(group), 0);
  // 打开时焦点落在面板本身，不落在第一个“任一成员”上。
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root>
      <Popover.Trigger className="proto-groups-btn">
        <Tags size={18} aria-hidden="true" /><span className="k-label">分组</span>
        {total > 0 && <span className="badge tabular">{total}</span>}
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" className="proto-groups-chev" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="start" sideOffset={10}>
          <Popover.Popup ref={popup} initialFocus={popup} className="k-popup proto-groups-pop" aria-label="标签分组">
            <div className="proto-groups-list">
              {groups.map((group) => (
                <section key={group.id} className="proto-group">
                  <header>
                    <h3>{group.name}</h3>
                    <button type="button" className="proto-any" aria-pressed={search.input.conditions.some(search.isAny(group))} onClick={() => search.anyOf(group)}>任一成员</button>
                  </header>
                  <div className="chips">
                    {group.tags.map(({ tag, count }) => {
                      const condition = search.used(tag.id);
                      return (
                        <button type="button" key={tag.id} className={`chip pick${condition ? (condition.negate ? " is-neg" : " is-on") : ""}`} aria-pressed={!!condition}
                          onClick={() => search.pick(tag.id)} onContextMenu={(event) => search.exclude(tag.id, event)}>
                          <span className="k-label">{tag.name}</span><span className="count tabular k-label">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
            <div className="k-sep" />
            <Popover.Close className="k-item proto-groups-edit" onClick={editGroups}>
              <span className="k-item-ind"><PenLine size={14} aria-hidden="true" /></span><span className="k-item-label">编辑分组</span>
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SideGroups() {
  const search = useSearch();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((previous) => { const next = new Set(previous); if (!next.delete(id)) next.add(id); return next; });
  return (
    <section className="proto-side-groups" aria-label="标签分组">
      <div className="lib-head">
        <span className="proto-side-title">标签分组</span>
        <button type="button" className="k-icon-btn lib-more" aria-label="编辑分组" title="编辑分组" onClick={editGroups}><PenLine size={14} aria-hidden="true" /></button>
      </div>
      {groups.map((group) => {
        const picked = search.picked(group);
        const expanded = open.has(group.id);
        return (
          <div key={group.id}>
            <button type="button" className="k-row" aria-expanded={expanded} onClick={() => toggle(group.id)}>
              <span className="k-row-icon">{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
              <span className="sidebar-label">{group.name}</span>
              {picked > 0 ? <span className="badge tabular">{picked}</span> : <span className="sidebar-count">{group.tags.length}</span>}
            </button>
            {expanded && group.tags.map(({ tag, count }) => {
              const condition = search.used(tag.id);
              return (
                <button type="button" key={tag.id} className="k-row proto-tag-row" aria-pressed={!!condition} data-negate={condition?.negate || undefined}
                  onClick={() => search.pick(tag.id)} onContextMenu={(event) => search.exclude(tag.id, event)}>
                  <span className="sidebar-label">{tag.name}</span><span className="sidebar-count">{count}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

/** 把原型的分组入口放进正式程序的界面里：顶栏的查找框后面，或左栏滚动区的末尾。界面重画把它挤掉时再放回去。 */
export function mountGroups(mode: "panel" | "side") {
  const host = document.createElement("div");
  host.className = mode === "panel" ? "proto-groups-host" : "proto-side-host";
  createRoot(host).render(mode === "panel" ? <GroupsPanel /> : <SideGroups />);
  const place = () => {
    if (host.isConnected) return;
    if (mode === "panel") document.querySelector(".topbar > .search")?.after(host);
    else document.querySelector(".side-scroll")?.append(host);
  };
  place();
  setInterval(place, 200);
}
