import type { ComponentProps, ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";

/**
 * Shared Base UI menu parts with the project styling (design/ui-system/README.md, 组件对照).
 * Popups render in a portal; `side`/`align` follow Base UI's positioner.
 */
export function MenuPopup({ children, width, align = "start", sideOffset = 6, className = "", label }: {
  children: ReactNode; width?: number; align?: "start" | "center" | "end"; sideOffset?: number; className?: string; label?: string;
}) {
  return <Menu.Portal><Menu.Positioner className="k-positioner" sideOffset={sideOffset} align={align}>
    <Menu.Popup className={`k-popup ${className}`} style={width ? { width } : undefined} aria-label={label}>{children}</Menu.Popup>
  </Menu.Positioner></Menu.Portal>;
}

/** One menu row: leading icon aligned in a 16 px column, optional shortcut hint, danger rows in red. */
export function MenuItem({ icon, children, kbd, danger, className = "", ...props }: ComponentProps<typeof Menu.Item> & {
  icon?: ReactNode; kbd?: string; danger?: boolean;
}) {
  return <Menu.Item {...props} className={`k-item${danger ? " is-danger" : ""} ${className}`}>
    <span className="k-item-ind" aria-hidden="true">{icon}</span>
    <span className="k-item-label">{children}</span>
    {kbd && <kbd className="k-kbd">{kbd}</kbd>}
  </Menu.Item>;
}

/** A radio row with a check in the leading column. */
export function MenuRadioItem({ children, meta, className = "", ...props }: ComponentProps<typeof Menu.RadioItem> & { meta?: ReactNode }) {
  return <Menu.RadioItem closeOnClick {...props} className={`k-item ${className}`}>
    <span className="k-item-ind" aria-hidden="true"><Menu.RadioItemIndicator><Check size={14} /></Menu.RadioItemIndicator></span>
    <span className="k-item-label">{children}</span>
    {meta !== undefined && <span className="k-item-meta">{meta}</span>}
  </Menu.RadioItem>;
}

export const MenuSeparator = () => <Menu.Separator className="k-sep" />;
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="k-menu-label" role="presentation">{children}</div>;
}
/** A non-interactive hint row aligned with the items above it. */
export function MenuTip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="k-item is-tip" role="note"><span className="k-item-ind" aria-hidden="true">{icon}</span><span className="k-item-label">{children}</span></div>;
}

export { Menu };
