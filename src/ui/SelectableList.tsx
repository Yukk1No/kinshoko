import { useId, useRef, useState, type ReactNode } from "react";
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
  const visible = eligible.length + (expanded ? done.length : 0);
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
    <div className="k-choice-list">
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
            <span className="k-label">{t("selectAll")}</span>
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
        {doneCount > 0 && (
          <button
            key="subscribed-toggle"
            type="button"
            className="k-btn is-quiet"
            disabled={disabled}
            aria-expanded={expanded}
            aria-controls={groupId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="k-label">{t(expanded ? "hideSubscribed" : "showSubscribed", { count: doneCount })}</span>
          </button>
        )}
        <span className="k-description k-choice-count">{t("showing", { shown: visible, total: items.length })}</span>
      </div>
      <div className="k-choice-scroll" ref={scroll}>
        {status ?? (
          <>
            {visible === 0 && <p className="k-description k-choice-status">{t("noMatches")}</p>}
            <ul className="k-choice-items" aria-label={label}>
              {eligible.map(row)}
            </ul>
            <div id={groupId} hidden={!expanded}>
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
