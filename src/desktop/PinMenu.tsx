import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus, Copy, Eye, ExternalLink, FlipHorizontal2, FlipVertical2, Layers, PanelRightClose,
  RotateCcw, RotateCw, Save, Scan, SunDim, X,
} from "lucide-react";
import { Menu, MenuCheckboxItem, MenuItem, MenuRadioItem, MenuSeparator, MenuSubmenu, MenuTip } from "../ui/Menu";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { PinMenu } from "../bindings/PinMenu";
import type { PinMenuOpen } from "../bindings/PinMenuOpen";
import {
  closeDesktopMenu, desktopMenu, desktopMenuShown, onDesktopMenu, pinMenuAction, referenceGroups,
  type PinMenuAction,
} from "../ipc";

/** 透明度子菜单的几档（百分比），与原生菜单相同。Ctrl+滚轮可以调到中间的值。 */
export const OPACITY_STEPS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];

const icon = (Icon: typeof X) => <Icon size={14} />;

/** 子菜单打开时才读参考组；读不到时显示原因。 */
function GroupList({ load, act }: { load: () => Promise<GroupSummary[]>; act: (a: PinMenuAction) => void }) {
  const [state, setState] = useState<{ items: GroupSummary[] | null; problem: string | null }>({ items: null, problem: null });
  useEffect(() => {
    let alive = true;
    load().then((items) => alive && setState({ items, problem: null }), (e) => alive && setState({ items: [], problem: String(e) }));
    return () => { alive = false; };
    // 每次打开子菜单只读一次。
  }, []);
  const { items, problem } = state;
  if (!items) return <MenuTip>正在读取参考组…</MenuTip>;
  if (problem) return <MenuTip>{problem}</MenuTip>;
  const usable = items.filter((g) => !g.problem);
  if (!usable.length) return <MenuTip>还没有参考组，可在主窗口侧栏“参考组”里新建</MenuTip>;
  return <>{usable.map((g) => <MenuItem key={g.id} onClick={() => act(`group:${g.id}`)}>{g.name}</MenuItem>)}</>;
}

/**
 * 桌面钉图的右键菜单内容（#102 “右键菜单”表的“桌面钉图”一行）：原生菜单的各项逐项保留——翻转、旋转、
 * 原始大小、透明度、锁定，截图钉图的收藏与复制，资料库钉图的显示遮蔽图与存回参考组——再加上
 * 在 Kinshoko 中打开、加入参考组 ▸、贴边隐藏与关闭钉图。快捷键提示与钉图窗口的按键一致。
 */
export function PinMenuItems({ menu, act, dismiss = () => {}, groups = referenceGroups }: {
  menu: PinMenu; act: (action: PinMenuAction) => void; dismiss?: () => void; groups?: () => Promise<GroupSummary[]>;
}) {
  // 点了遮蔽钉图上的小圆锁：只问这一句。
  if (menu.confirmReveal) return <>
    <MenuTip>显示这张图？</MenuTip>
    <MenuItem icon={icon(Eye)} onClick={() => act("reveal")}>显示</MenuItem>
    <MenuItem icon={icon(X)} onClick={dismiss}>取消</MenuItem>
  </>;
  const opacity = OPACITY_STEPS.includes(menu.opacity) ? menu.opacity : null;
  return <>
    <MenuItem icon={icon(FlipHorizontal2)} kbd="H" onClick={() => act("flipH")}>水平翻转</MenuItem>
    <MenuItem icon={icon(FlipVertical2)} kbd="V" onClick={() => act("flipV")}>垂直翻转</MenuItem>
    <MenuItem icon={icon(RotateCw)} kbd="R" onClick={() => act("rotateCw")}>顺时针旋转 90°</MenuItem>
    <MenuItem icon={icon(RotateCcw)} kbd="Shift R" onClick={() => act("rotateCcw")}>逆时针旋转 90°</MenuItem>
    <MenuSeparator />
    <MenuItem icon={icon(Scan)} disabled={menu.locked || menu.actualSize} onClick={() => act("actualSize")}>原始大小（100%）</MenuItem>
    <MenuSubmenu icon={icon(SunDim)} label="透明度" meta={`${menu.opacity}%`} popupLabel="透明度">
      <Menu.RadioGroup value={opacity} onValueChange={(value) => act(`opacity:${value as number}`)}>
        {OPACITY_STEPS.map((p) => <MenuRadioItem key={p} value={p}>{p}%</MenuRadioItem>)}
      </Menu.RadioGroup>
    </MenuSubmenu>
    <MenuCheckboxItem checked={menu.locked} onCheckedChange={() => act("lock")}>锁定位置与大小</MenuCheckboxItem>
    <MenuSeparator />
    {menu.capture && (
      <MenuItem icon={icon(BookmarkPlus)} disabled={!menu.canCollect} onClick={() => act("collect")}>
        {menu.canCollect ? "收藏到…" : "收藏（还没有图库）"}
      </MenuItem>
    )}
    {/* 资料库钉图复制钉图显示的那一块原图像素（#289）；被遮蔽时不能复制。 */}
    <MenuItem icon={icon(Copy)} disabled={menu.veiled} onClick={() => act("copy")}>复制</MenuItem>
    {!menu.capture && menu.veiled && <MenuItem icon={icon(Eye)} onClick={() => act("reveal")}>显示这张图（安全模式下已遮蔽）</MenuItem>}
    {!menu.capture && menu.group !== null && <MenuItem icon={icon(Save)} onClick={() => act("saveGroup")}>存回参考组「{menu.group}」</MenuItem>}
    <MenuSeparator />
    <MenuItem icon={icon(ExternalLink)} onClick={() => act("openInKinshoko")}>在 Kinshoko 中打开</MenuItem>
    <MenuSubmenu icon={icon(Layers)} label="加入参考组" popupLabel="加入参考组" width={220}>
      {menu.capture
        ? <MenuTip>截图要先收藏进图库，才能加入参考组</MenuTip>
        : <GroupList load={groups} act={act} />}
    </MenuSubmenu>
    <MenuItem icon={icon(PanelRightClose)} onClick={() => act("edgeHide")}>贴边隐藏</MenuItem>
    <MenuSeparator />
    <MenuItem icon={icon(X)} kbd="Esc" onClick={() => act("close")}>关闭钉图</MenuItem>
  </>;
}

/** 指针在页面里的位置（CSS 像素）：应用壳给的是相对菜单窗口的物理像素。 */
export function menuAnchor(open: PinMenuOpen, dpr: number): { x: number; y: number } {
  const scale = dpr > 0 ? dpr : 1;
  return { x: open.surface.x / scale, y: open.surface.y / scale };
}

/**
 * 钉图菜单窗口（`?view=desktop-menu`）：一个置顶、无边框、透明的窗口，盖住指针所在的显示器（让出最下面一行，#230）。
 * 钉图窗口小且透明，菜单不在钉图里渲染，而在这里从指针处弹出；Base UI 的碰撞规则让菜单与子菜单
 * 留在窗口（即这台显示器）之内。Esc、点外部、窗口失去焦点都关闭菜单；选中一项后由应用壳先收起
 * 菜单窗口再做这件事，提示显示在钉图上。窗口用完只隐藏，下次右键直接复用。
 */
export function DesktopMenuView() {
  const [open, setOpen] = useState<PinMenuOpen | null>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  /** 已经处理过（选中或关闭）的那一次菜单，免得关闭时再发一次。 */
  const handled = useRef<number | null>(null);
  const current = useRef<PinMenuOpen | null>(null);
  current.current = open;

  const accept = useCallback((next: PinMenuOpen) => {
    handled.current = null;
    setOpen(next);
  }, []);
  const dismiss = useCallback(() => {
    const now = current.current;
    if (!now || handled.current === now.generation) return;
    handled.current = now.generation;
    setOpen(null);
    void closeDesktopMenu(now.generation).catch(() => {});
  }, []);
  const act = useCallback((action: PinMenuAction) => {
    const now = current.current;
    if (!now || handled.current === now.generation) return;
    handled.current = now.generation;
    setOpen(null);
    void pinMenuAction(now.menu.pin, action, now.generation).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    void desktopMenu().then((first) => { if (alive && first && !current.current) accept(first); }, () => {});
    const stop = onDesktopMenu((next) => { if (alive) accept(next); });
    const onResize = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", dismiss);
    return () => {
      alive = false;
      void stop.then((fn) => fn());
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", dismiss);
    };
  }, [accept, dismiss]);

  // 菜单画好后才显示窗口并拿焦点，免得先闪一下空窗口。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => void desktopMenuShown(open.generation).catch(() => {}));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const point = open ? menuAnchor(open, dpr) : null;
  const anchor = useMemo(() => point && {
    getBoundingClientRect: () => DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
  }, [point?.x, point?.y]);

  return <>
    {/* 点在菜单外（同一台显示器上）就关闭；别的显示器上的点击经窗口失去焦点关闭。 */}
    <div className="desktop-menu-backdrop" onPointerDown={dismiss} onContextMenu={(e) => { e.preventDefault(); dismiss(); }} />
    {open && anchor && (
      <Menu.Root key={open.generation} open modal={false} onOpenChange={(next, details) => {
        // 根菜单没有同级菜单：没有触发元素的根菜单会把自己的子菜单当成同级，子菜单一打开就把整个菜单关掉（#309）。
        if (!next && details.reason === "sibling-open") { details.cancel(); return; }
        if (!next) dismiss();
      }}>
        <Menu.Portal>
          <Menu.Positioner className="k-positioner" anchor={anchor} side="bottom" align="start" sideOffset={2} collisionPadding={4}>
            <Menu.Popup className="k-popup" aria-label="钉图菜单" onContextMenu={(e) => e.preventDefault()}>
              <PinMenuItems menu={open.menu} act={act} dismiss={dismiss} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    )}
  </>;
}
