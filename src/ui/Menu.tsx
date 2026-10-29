import { useMemo, type ComponentProps, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";

/**
 * Shared Base UI menu parts with the project styling (design/ui-system/README.md, 组件对照).
 * Popups render in a portal; `side`/`align` follow Base UI's positioner.
 */
export function MenuPopup({ children, width, side, align = "start", sideOffset = 6, className = "", label }: {
  children: ReactNode; width?: number; side?: "top" | "bottom"; align?: "start" | "center" | "end"; sideOffset?: number; className?: string; label?: string;
}) {
  return <Menu.Portal><Menu.Positioner className="k-positioner" side={side} sideOffset={sideOffset} align={align}>
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

/**
 * 一个从页面上某一点弹出、没有触发元素的菜单（钉图菜单窗口用它，#309）。主菜单和它的子菜单是一棵树，
 * 作为整体打开和关闭：在树里移动指针、焦点在主菜单与子菜单之间来回都不算离开；Esc、点在树外、
 * 焦点离开整棵树时调一次 `onClose`。
 *
 * 用 ContextMenu 的根而不是 Menu 的根：没有触发元素的 Menu 根不登记成菜单树的根节点，子菜单一打开
 * 或焦点一移进子菜单，它就当成别处的菜单把自己关掉。
 */
export function PointerMenu({ point, label, onClose, children }: {
  point: { x: number; y: number }; label: string; onClose: () => void; children: ReactNode;
}) {
  const anchor = useMemo(() => ({
    getBoundingClientRect: () => DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
  }), [point.x, point.y]);
  return <ContextMenu.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
    <Menu.Portal>
      <Menu.Positioner className="k-positioner" anchor={anchor} side="bottom" align="start" sideOffset={2} collisionPadding={4}>
        <Menu.Popup className="k-popup" aria-label={label} onContextMenu={(e) => e.preventDefault()}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </ContextMenu.Root>;
}

export { Menu };
