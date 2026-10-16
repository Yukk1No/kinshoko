import type { ComponentProps, ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";

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

/** A checkbox row (“锁定位置与大小”) with a check in the leading column. */
export function MenuCheckboxItem({ children, kbd, className = "", ...props }: ComponentProps<typeof Menu.CheckboxItem> & { kbd?: string }) {
  return <Menu.CheckboxItem closeOnClick {...props} className={`k-item ${className}`}>
    <span className="k-item-ind" aria-hidden="true"><Menu.CheckboxItemIndicator><Check size={14} /></Menu.CheckboxItemIndicator></span>
    <span className="k-item-label">{children}</span>
    {kbd && <kbd className="k-kbd">{kbd}</kbd>}
  </Menu.CheckboxItem>;
}

/**
 * A row that opens a nested menu (“放入文件夹 ▸”). The nested popup mounts only while open,
 * so lists it loads (folders, reference groups) are read when the artist reaches them.
 */
export function MenuSubmenu({ icon, label, children, disabled, meta, width, popupLabel }: {
  icon?: ReactNode; label: ReactNode; children: ReactNode; disabled?: boolean; meta?: ReactNode; width?: number; popupLabel?: string;
}) {
  return <Menu.SubmenuRoot disabled={disabled}>
    <Menu.SubmenuTrigger className="k-item is-sub" disabled={disabled}>
      <span className="k-item-ind" aria-hidden="true">{icon}</span>
      <span className="k-item-label">{label}</span>
      {meta !== undefined && <span className="k-item-meta">{meta}</span>}
      <ChevronRight className="k-item-sub" size={14} aria-hidden="true" />
    </Menu.SubmenuTrigger>
    <MenuPopup width={width} label={popupLabel} sideOffset={2}>{children}</MenuPopup>
  </Menu.SubmenuRoot>;
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
