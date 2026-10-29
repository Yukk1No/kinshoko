import type { ReactNode } from "react";
import { Select as Base } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption<V extends string = string> = { value: V; label: ReactNode; disabled?: boolean };

/**
 * 下拉选择（设计系统 Select）：替换原生 `select`。触发器 `.k-select` 与 TextField 同高同圆角，
 * 列表是 Combobox 的 `.k-popup.k-listbox`，与触发器同宽、下方 4 px；当前值在指示列放勾。
 * `label` 是触发器的可访问名称；`icon` 是值前面的 16 px 图标。触发器与各项带 `data-value`，测试按值挑选。
 */
export function Select<V extends string>({ value, options, onChange, label, disabled, icon, className = "", title }: {
  value: V; options: SelectOption<V>[]; onChange: (value: V) => void; label: string;
  disabled?: boolean; icon?: ReactNode; className?: string; title?: string;
}) {
  return <Base.Root<V> value={value} disabled={disabled} items={options} onValueChange={(next) => { if (next !== null && next !== value) onChange(next); }}>
    <Base.Trigger className={`k-select ${className}`} aria-label={label} title={title} data-value={value}>
      {icon}
      <Base.Value className="k-select-value" />
      <ChevronDown size={16} aria-hidden="true" />
    </Base.Trigger>
    <Base.Portal>
      <Base.Positioner className="k-positioner is-field" alignItemWithTrigger={false} side="bottom" align="start" sideOffset={4}>
        <Base.Popup className="k-popup k-select-popup">
          <Base.List className="k-listbox">
            {options.map((option) => <Base.Item key={option.value} value={option.value} disabled={option.disabled} className="k-item k-option" data-value={option.value}>
              <span className="k-item-ind" aria-hidden="true"><Base.ItemIndicator><Check size={14} /></Base.ItemIndicator></span>
              <Base.ItemText className="k-item-label">{option.label}</Base.ItemText>
            </Base.Item>)}
          </Base.List>
        </Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  </Base.Root>;
}
