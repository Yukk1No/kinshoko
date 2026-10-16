import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";
import { MenuPopup } from "./Menu";

/**
 * A pill split in two (after Arc's split-button): the main half runs the common action straight
 * away, the chevron opens the other choices. The pill presses to 0.97; the chevron turns while open.
 * Without `label` it is the quiet icon-only form (no fill, `--hover` on hover), e.g. 导入 in the top bar.
 */
export function SplitButton({ icon, label, mainLabel, onMain, mainDisabled, busy, menuLabel, menuDisabled, menuWidth = 232, children, className = "" }: {
  icon?: ReactNode; label?: ReactNode; mainLabel?: string; onMain: () => void; mainDisabled?: boolean; busy?: boolean;
  menuLabel: string; menuDisabled?: boolean; menuWidth?: number; children: ReactNode; className?: string;
}) {
  return <div className={`k-split${label === undefined ? " is-quiet" : ""} ${className}`}>
    <button type="button" className="k-split-main" aria-label={mainLabel} title={mainLabel} aria-busy={busy || undefined} disabled={mainDisabled} onClick={onMain}>{icon}{label}</button>
    <Menu.Root modal={false}>
      <Menu.Trigger className="k-split-more" aria-label={menuLabel} title={menuLabel} disabled={menuDisabled}><ChevronDown size={14} aria-hidden="true" /></Menu.Trigger>
      <MenuPopup align="end" sideOffset={8} width={menuWidth}>{children}</MenuPopup>
    </Menu.Root>
  </div>;
}
