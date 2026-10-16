import type { ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown } from "lucide-react";
import { MenuPopup } from "./Menu";

/**
 * One ink pill split in two (after Arc's split-button): the main half runs the common action straight
 * away, the 32 px chevron opens the other choices. The pill presses to 0.97; the chevron turns while open.
 */
export function SplitButton({ icon, label, mainLabel, onMain, mainDisabled, menuLabel, menuDisabled, menuWidth = 232, children, className = "" }: {
  icon?: ReactNode; label: ReactNode; mainLabel?: string; onMain: () => void; mainDisabled?: boolean;
  menuLabel: string; menuDisabled?: boolean; menuWidth?: number; children: ReactNode; className?: string;
}) {
  return <div className={`k-split ${className}`}>
    <button type="button" className="k-split-main" aria-label={mainLabel} title={mainLabel} disabled={mainDisabled} onClick={onMain}>{icon}{label}</button>
    <Menu.Root modal={false}>
      <Menu.Trigger className="k-split-more" aria-label={menuLabel} title={menuLabel} disabled={menuDisabled}><ChevronDown size={14} aria-hidden="true" /></Menu.Trigger>
      <MenuPopup align="end" sideOffset={8} width={menuWidth}>{children}</MenuPopup>
    </Menu.Root>
  </div>;
}
