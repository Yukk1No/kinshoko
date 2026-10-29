import type { ReactNode } from "react";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";

/**
 * Segmented switch (Base UI ToggleGroup, single choice) on the sunken track. `value` null means no
 * segment is chosen yet; choosing the pressed segment again keeps it (no deselect).
 */
export function Segmented<T extends string>({ value, options, onChange, label, className = "" }: {
  value: T | null; onChange: (value: T) => void; label: string; className?: string;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string; ariaLabel?: string }[];
}) {
  return <ToggleGroup className={`k-seg ${className}`} aria-label={label} value={value === null ? [] : [value]}
    onValueChange={(next) => { const picked = next[0] as T | undefined; if (picked !== undefined && picked !== value) onChange(picked); }}>
    {options.map((option) => <Toggle key={option.value} value={option.value} className="k-seg-item" disabled={option.disabled}
      title={option.title} aria-label={option.ariaLabel}><span className="k-label">{option.label}</span></Toggle>)}
  </ToggleGroup>;
}
