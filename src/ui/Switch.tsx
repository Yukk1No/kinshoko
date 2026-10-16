import { Switch as Base } from "@base-ui/react/switch";

/** Base UI Switch with the project styling; `size="sm"` is the 28 × 16 sidebar variant. */
export function Switch({ checked, onCheckedChange, disabled, label, size = "md", id }: {
  checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; label?: string; size?: "sm" | "md"; id?: string;
}) {
  return <Base.Root id={id} className={`k-switch${size === "sm" ? " is-sm" : ""}`} checked={checked} disabled={disabled}
    aria-label={label} onCheckedChange={(next) => onCheckedChange(next)}>
    <Base.Thumb className="k-switch-thumb" />
  </Base.Root>;
}
