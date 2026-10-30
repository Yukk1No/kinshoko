import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore,
  type ComponentProps, type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";
import { CascadeController, menuDebugEnabled } from "./menu/cascade";
import { menuMotionVars } from "./menu/timing";

/**
 * Shared Base UI menu parts with the project styling (design/ui-system/README.md, 组件对照).
 * Popups render in a portal; `side`/`align` follow Base UI's positioner.
 *
 * 每棵菜单树有一个 CascadeController（src/ui/menu/cascade.ts）：子菜单悬停 220 ms 才打开，斜着朝子菜单移动时
 * 途经的行不高亮也不换子菜单（安全区），按钮打开的菜单在指针离开 360 ms 后整个关闭。键盘与读屏仍由 Base UI 负责。
 */

type Cascade = { ctrl: CascadeController; depth: number };
const CascadeContext = createContext<Cascade | null>(null);
/** 文件夹行的子菜单是否展开（FolderGlyph 读它）。 */
const SubmenuOpenContext = createContext(false);

const newController = () => {
  const ctrl = new CascadeController();
  ctrl.debug = menuDebugEnabled();
  return ctrl;
};

/**
 * 子菜单的位置：与父层重叠 8 px，首行与父层那一行对齐。浮层的描边 1 + 内边距 6；行在父层里离父层右边 7 px，
 * 所以子菜单相对行右边 −1 px 就是与父层重叠 8 px。标题行 20 px（11 px 字、14 px 行高、上 4 下 2）加行距 4。
 */
const SUBMENU_SIDE_OFFSET = -1;
const LEVEL_INSET = 1 + 6;
const TITLE_BLOCK = 20 + 4;

const NO_SUBSCRIBE = () => () => {};
const HOVER = 1, ACTIVE = 2, SKIPPED = 4;

/** 一行的标记与它在 cascade 状态里的高亮（悬停、展开、安全区里被跳过）。 */
function useRow(kind: "folder" | "plain") {
  const cascade = useContext(CascadeContext);
  const id = useId();
  const flags = useSyncExternalStore(cascade?.ctrl.subscribe ?? NO_SUBSCRIBE, () => {
    if (!cascade) return 0;
    const s = cascade.ctrl.getState();
    return (s.hover[cascade.depth] === id ? HOVER : 0) | (s.open[cascade.depth] === id ? ACTIVE : 0) | (s.skipped === id ? SKIPPED : 0);
  });
  return {
    id, cascade, open: (flags & ACTIVE) !== 0,
    props: {
      "data-k-row": id, "data-k-depth": cascade?.depth ?? 0, "data-k-kind": kind,
      "data-k-hover": flags & HOVER ? "" : undefined, "data-k-active": flags & ACTIVE ? "" : undefined,
      "data-k-skipped": flags & SKIPPED ? "" : undefined,
    },
  };
}

/** 菜单的一层浮层：向 controller 登记自己，并标出当前输入方式（指针时高亮跟 cascade 状态走，键盘时跟焦点走）。 */
function Level({ cascade, title, className = "", style, label, children, ...props }: Omit<ComponentProps<typeof BaseMenu.Popup>, "className" | "style"> & {
  cascade: Cascade; title?: string; className?: string; style?: CSSProperties; label?: string;
}) {
  const { ctrl, depth } = cascade;
  const input = useSyncExternalStore(ctrl.subscribe, () => ctrl.getState().input);
  const el = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    const prev = el.current;
    el.current = node;
    ctrl.registerLevel(depth, node, prev);
  }, [ctrl, depth]);
  return <BaseMenu.Popup {...props} ref={ref} data-k-level={depth} data-k-input={input} className={`k-popup ${className}`}
    style={{ ...menuMotionVars, ...style }} aria-label={label}>
    {title && <div className="k-menu-title" aria-hidden="true">{title}</div>}
    {children}
  </BaseMenu.Popup>;
}

/** 根层：有外层（Menu.Root）给的 controller 就用它，没有（右键菜单）就自己建一个，随浮层卸下而丢弃。 */
function useRootCascade(): Cascade {
  const outer = useContext(CascadeContext);
  const [own] = useState(() => (outer ? null : newController()));
  return useMemo(() => outer ?? { ctrl: own!, depth: 0 }, [outer, own]);
}

export function MenuPopup({ children, width, side, align = "start", sideOffset = 6, className = "", label }: {
  children: ReactNode; width?: number; side?: "top" | "bottom"; align?: "start" | "center" | "end"; sideOffset?: number; className?: string; label?: string;
}) {
  const cascade = useRootCascade();
  return <CascadeContext.Provider value={cascade}>
    <BaseMenu.Portal><BaseMenu.Positioner className="k-positioner" side={side} sideOffset={sideOffset} align={align}>
      <Level cascade={cascade} className={className} style={width ? { width } : undefined} label={label}>{children}</Level>
    </BaseMenu.Positioner></BaseMenu.Portal>
    {cascade.ctrl.debug && <MenuDebugOverlay ctrl={cascade.ctrl} />}
  </CascadeContext.Provider>;
}

/** One menu row: leading icon aligned in an 18 px column, optional shortcut hint, danger rows in red. */
export function MenuItem({ icon, children, kbd, danger, className = "", ...props }: ComponentProps<typeof BaseMenu.Item> & {
  icon?: ReactNode; kbd?: string; danger?: boolean;
}) {
  const row = useRow("plain");
  return <BaseMenu.Item {...props} {...row.props} className={`k-item${danger ? " is-danger" : ""} ${className}`}>
    <span className="k-item-ind" aria-hidden="true">{icon}</span>
    <span className="k-item-label">{children}</span>
    {kbd && <kbd className="k-kbd">{kbd}</kbd>}
  </BaseMenu.Item>;
}

/** A radio row with a check in the leading column. */
export function MenuRadioItem({ children, meta, className = "", ...props }: ComponentProps<typeof BaseMenu.RadioItem> & { meta?: ReactNode }) {
  const row = useRow("plain");
  return <BaseMenu.RadioItem closeOnClick {...props} {...row.props} className={`k-item ${className}`}>
    <span className="k-item-ind" aria-hidden="true"><BaseMenu.RadioItemIndicator><Check size={14} /></BaseMenu.RadioItemIndicator></span>
    <span className="k-item-label">{children}</span>
    {meta !== undefined && <span className="k-item-meta">{meta}</span>}
  </BaseMenu.RadioItem>;
}

/** A checkbox row (“锁定位置与大小”) with a check in the leading column. */
export function MenuCheckboxItem({ children, kbd, className = "", ...props }: ComponentProps<typeof BaseMenu.CheckboxItem> & { kbd?: string }) {
  const row = useRow("plain");
  return <BaseMenu.CheckboxItem closeOnClick {...props} {...row.props} className={`k-item ${className}`}>
    <span className="k-item-ind" aria-hidden="true"><BaseMenu.CheckboxItemIndicator><Check size={14} /></BaseMenu.CheckboxItemIndicator></span>
    <span className="k-item-label">{children}</span>
    {kbd && <kbd className="k-kbd">{kbd}</kbd>}
  </BaseMenu.CheckboxItem>;
}

/**
 * A row that opens a nested menu (“放入文件夹 ▸”). The nested popup mounts only while open,
 * so lists it loads (folders, reference groups) are read when the artist reaches them.
 * 开合由 cascade 状态控制：指针悬停经延时与安全区决定，键盘与点击仍走 Base UI（经 requestOpen）。
 * 子菜单顶上是一个小标题（popupLabel，或字符串的 label）。
 */
export function MenuSubmenu({ icon, label, children, disabled, meta, width, popupLabel }: {
  icon?: ReactNode; label: ReactNode; children: ReactNode; disabled?: boolean; meta?: ReactNode; width?: number; popupLabel?: string;
}) {
  const row = useRow("folder");
  const parent = row.cascade!;
  const child = useMemo(() => ({ ctrl: parent.ctrl, depth: parent.depth + 1 }), [parent.ctrl, parent.depth]);
  const title = popupLabel ?? (typeof label === "string" ? label : undefined);
  return <BaseMenu.SubmenuRoot disabled={disabled} open={row.open}
    onOpenChange={(next, details) => parent.ctrl.requestOpen(parent.depth, row.id, next, details.reason)}>
    <BaseMenu.SubmenuTrigger {...row.props} className="k-item is-sub" disabled={disabled} openOnHover={false}>
      <SubmenuOpenContext.Provider value={row.open}>
        <span className="k-item-ind" aria-hidden="true">{icon}</span>
        <span className="k-item-label">{label}</span>
        {meta !== undefined && <span className="k-item-meta">{meta}</span>}
        <ChevronRight className="k-item-sub" size={16} aria-hidden="true" />
      </SubmenuOpenContext.Provider>
    </BaseMenu.SubmenuTrigger>
    <CascadeContext.Provider value={child}>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="k-positioner" sideOffset={SUBMENU_SIDE_OFFSET} alignOffset={-(LEVEL_INSET + (title ? TITLE_BLOCK : 0))}>
          <Level cascade={child} className="is-submenu" title={title} label={popupLabel} style={width ? { width } : undefined}>{children}</Level>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </CascadeContext.Provider>
  </BaseMenu.SubmenuRoot>;
}

/** 文件夹的两种形状共用同一组路径命令，开合时路径直接变形（Chromium 支持过渡 CSS `d`）。 */
const FOLDER_PATHS = {
  back: { closed: "M3 19 L3 5.5 Q3 4 4.5 4 L9 4 L11 6 L19.5 6 Q21 6 21 7.5 L21 9", open: "M3 19 L3 5.5 Q3 4 4.5 4 L9 4 L11 6 L17.5 6 Q19 6 19 7.5 L19 10" },
  front: { closed: "M3 9 L21 9 L21 18.5 Q21 20 19.5 20 L4.5 20 Q3 20 3 18.5 Z", open: "M6 10 L22.5 10 L20.3 18.9 Q20 20 18.8 20 L4.5 20 Q3 20 3 18.5 Z" },
};

/** 文件夹行的图标：子菜单展开时是打开的文件夹，收起时合上。只在 MenuSubmenu 的 icon 里用。 */
export function FolderGlyph({ size = 18 }: { size?: number }) {
  const open = useContext(SubmenuOpenContext);
  const path = (part: keyof typeof FOLDER_PATHS) => {
    const d = FOLDER_PATHS[part][open ? "open" : "closed"];
    return <path className={`k-folder-${part}`} d={d} style={{ d: `path("${d}")` } as CSSProperties} />;
  };
  return <svg className="k-folder" data-open={open || undefined} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path("back")}{path("front")}</svg>;
}

export const MenuSeparator = () => <BaseMenu.Separator className="k-sep" />;
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
  const cascade = useRootCascade();
  return <ContextMenu.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
    <CascadeContext.Provider value={cascade}>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="k-positioner" anchor={anchor} side="bottom" align="start" sideOffset={2} collisionPadding={4}>
          <Level cascade={cascade} label={label} onContextMenu={(e) => e.preventDefault()}>{children}</Level>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
      {cascade.ctrl.debug && <MenuDebugOverlay ctrl={cascade.ctrl} />}
    </CascadeContext.Provider>
  </ContextMenu.Root>;
}

/**
 * 按钮打开的菜单的根（替换 Base UI 的 Menu.Root，属性不变）：指针离开触发按钮、所有层与安全区 360 ms 后
 * 整个菜单关闭，及时回来就不关。右键菜单（ContextMenu.Root）不加这一条。
 */
function MenuRoot<Payload>(props: BaseMenu.Root.Props<Payload>) {
  const [ctrl] = useState(newController);
  const ownActions = useRef<BaseMenu.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? ownActions;
  useEffect(() => {
    ctrl.closeAll = () => actionsRef.current?.close();
    return () => { ctrl.closeAll = null; };
  }, [ctrl, actionsRef]);
  const cascade = useMemo(() => ({ ctrl, depth: 0 }), [ctrl]);
  const { onOpenChange } = props;
  const openChange = useCallback((open: boolean, details: BaseMenu.Root.ChangeEventDetails) => {
    if (open) ctrl.anchor = (details.event?.target as Element | null)?.closest?.<HTMLElement>("[aria-haspopup]") ?? null;
    onOpenChange?.(open, details);
  }, [ctrl, onOpenChange]);
  return <CascadeContext.Provider value={cascade}>
    <BaseMenu.Root {...props} actionsRef={actionsRef} onOpenChange={openChange} />
  </CascadeContext.Provider>;
}

/** 安全区调试层：蓝色 16% 填充、蓝色虚线描边的三角形，父层里生效的那一段，以及正在走的计时。 */
function MenuDebugOverlay({ ctrl }: { ctrl: CascadeController }) {
  const debug = useSyncExternalStore(ctrl.subscribe, ctrl.getDebug);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!debug.timer) return;
    let frame = requestAnimationFrame(function loop() { tick(); frame = requestAnimationFrame(loop); });
    return () => cancelAnimationFrame(frame);
  }, [debug.timer]);
  const { triangle, strip, timer } = debug;
  const left = timer ? Math.max(0, Math.round(timer.duration - (performance.now() - timer.startedAt))) : 0;
  return createPortal(<>
    <svg className="k-menu-debug" aria-hidden="true">
      {strip && <rect className="k-menu-debug-strip" x={strip.left} y={strip.top} width={strip.right - strip.left} height={strip.bottom - strip.top} />}
      {triangle && <polygon className="k-menu-debug-zone" points={triangle.map((p) => `${p.x},${p.y}`).join(" ")} />}
    </svg>
    {timer && <div className="k-menu-debug-timer" aria-hidden="true">{timer.label} {left} / {timer.duration} ms</div>}
  </>, document.body);
}

/** Base UI 的 Menu，只把 Root 换成带离开即关的 MenuRoot；其余部件原样。 */
export const Menu: Omit<typeof BaseMenu, "Root"> & { Root: typeof MenuRoot } = { ...BaseMenu, Root: MenuRoot };
