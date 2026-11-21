import { useId, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Name } from "./Name";
import "./selectable-list.css";

export type SelectableItem = {
  id: string;
  name: string;
  searchText?: string;
  done?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export function SelectableList({
  items,
  selected,
  onChange,
  label,
  filterLabel,
  controls = true,
  disabled = false,
  accentSelection = false,
  status,
}: {
  items: readonly SelectableItem[];
  selected: ReadonlySet<string>;
  onChange: (selected: ReadonlySet<string>) => void;
  label: string;
  filterLabel: string;
  controls?: boolean;
  disabled?: boolean;
  accentSelection?: boolean;
  status?: ReactNode;
}) {
  const { t } = useTranslation("common", { keyPrefix: "selectableList" });
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const groupId = useId();
  const needle = controls ? filter.trim().toLocaleLowerCase() : "";
  const matches = items.filter((item) =>
    `${item.name} ${item.searchText ?? item.id}`.toLocaleLowerCase().includes(needle),
  );
  const eligible = matches.filter((item) => !item.done);
  const done = matches.filter((item) => item.done);
  const doneCount = items.filter((item) => item.done).length;
  // 筛选时已订阅的也列出来：找一位画师时能看到他已经订阅了，而不是“没有匹配的项目”。
  const filtering = needle !== "";
  const showDone = expanded || filtering;
  const visible = eligible.length + (showDone ? done.length : 0);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const row = (item: SelectableItem) => (
    <li
      key={item.id}
      className={`k-choice-row${item.done ? " is-done" : accentSelection && selected.has(item.id) ? " is-on" : ""}`}
    >
      <label className="k-choice-pick">
        <input
          type="checkbox"
          aria-label={item.name}
          disabled={disabled || item.done}
          checked={item.done || selected.has(item.id)}
          onChange={() => toggle(item.id)}
        />
        {item.leading && (
          <span className="k-choice-leading" aria-hidden="true">
            {item.leading}
          </span>
        )}
        <Name className="k-choice-name">{item.name}</Name>
      </label>
      {item.trailing && <span className="k-choice-trailing">{item.trailing}</span>}
    </li>
  );
  return (
    // 对话框很矮时名单最少留三行（不足三行按实际行数）：筛选框与工具行各 32 px、间距 16 px，加上行高 40 px。再不够由对话框整体滚动。
    <div
      className="k-choice-list"
      style={
        { "--k-choice-floor": `${(controls ? 96 : 48) + 40 * Math.max(1, Math.min(3, visible))}px` } as CSSProperties
      }
    >
      {controls && (
        <span className="k-input" key="filter">
          <Search size={16} aria-hidden="true" />
          <input
            value={filter}
            aria-label={filterLabel}
            placeholder={filterLabel}
            disabled={disabled}
            onChange={(e) => {
              setFilter(e.target.value);
              if (scroll.current) scroll.current.scrollTop = 0;
            }}
          />
        </span>
      )}
      <div className="k-choice-tools">
        {controls && (
          <button
            key="select-all"
            type="button"
            className="k-btn is-quiet"
            disabled={disabled || !eligible.some((item) => !selected.has(item.id))}
            onClick={() => {
              const next = new Set(selected);
              for (const item of eligible) next.add(item.id);
              onChange(next);
            }}
          >
            <span className="k-label">
              {filtering ? t("selectAllMatches", { count: eligible.length }) : t("selectAll")}
            </span>
          </button>
        )}
        {controls && (
          <button
            key="clear"
            type="button"
            className="k-btn is-quiet"
            disabled={disabled || selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            <span className="k-label">{t("clear")}</span>
          </button>
        )}
        {doneCount > 0 && !filtering && (
          <button
            key="subscribed-toggle"
            type="button"
            className="k-btn is-quiet"
            disabled={disabled}
            aria-expanded={expanded}
            aria-controls={groupId}
            onClick={() => {
              const next = !expanded;
              setExpanded(next);
              // 已订阅的排在名单最后：展开后把它们滚进视野，不然首屏看不出有变化。
              if (next)
                requestAnimationFrame(() => document.getElementById(groupId)?.scrollIntoView({ block: "nearest" }));
            }}
          >
            <span className="k-label">{t(expanded ? "hideSubscribed" : "showSubscribed", { count: doneCount })}</span>
          </button>
        )}
        {filtering && (
          <span className="k-description k-choice-count">
            {done.length > 0
              ? t("matchesWithDone", { count: visible, done: done.length })
              : t("matches", { count: visible })}
          </span>
        )}
      </div>
      <div className="k-choice-scroll" ref={scroll}>
        {status ?? (
          <>
            {visible === 0 && <p className="k-description k-choice-status">{t("noMatches")}</p>}
            <ul className="k-choice-items" aria-label={label}>
              {eligible.map(row)}
            </ul>
            <div id={groupId} hidden={!showDone}>
              {done.length > 0 && (
                <>
                  <p className="k-section-label k-choice-group">{t("subscribed", { count: done.length })}</p>
                  <ul className="k-choice-items" aria-label={t("subscribed", { count: done.length })}>
                    {done.map(row)}
                  </ul>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
