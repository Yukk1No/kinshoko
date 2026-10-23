import { useEffect, useState } from "react";
import type { Region } from "../bindings/Region";
import { shellSettings, migrateViewerBackground, setViewerBackground } from "../ipc";
import { legacyViewerBackground, rememberViewerBackground } from "./background";
import { Copy, Crop as CropIcon, FolderSearch, PanelRight, Palette, Pin, Scan, Trash2 } from "lucide-react";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuRadioItem, MenuSeparator, MenuSubmenu } from "../ui/Menu";
import type { DockItem } from "../ui/Dock";
import type { CSSProperties, Dispatch, SetStateAction } from "react";

export type Background = "dark" | "mid" | "light" | "checker";
export const grounds: Background[] = ["dark", "mid", "light", "checker"];
export const groundNames: Record<Background, string> = { dark: "深灰", mid: "中灰", light: "浅灰", checker: "棋盘格" };
/** 查看器 dock 底部留给自己的高度，框选 dock 不压在它上面。 */
export const DOCK_RESERVE = 76;
export const swatch = (ground: Background) => <span className="viewer-swatch" data-ground={ground} aria-hidden="true" />;
export const OneToOne = ({ size = 19 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M8.5 10v5M8 10.5l.5-.5M15.5 10v5M15 10.5l.5-.5" /><path d="M12 11.2v.1M12 14v.1" /></svg>;

/** 查看器的背景：本设备设置，读到之前沿用旧的本机缓存（从 Viewer 拆出）。 */
export function useViewerBackground() {
  const [background, setBackground] = useState<Background>(legacyViewerBackground);
  const [backgroundReady, setBackgroundReady] = useState(false);
  useEffect(() => {
    let alive = true;
    shellSettings().then(async (view) => view?.viewerBackground ?? (await migrateViewerBackground(legacyViewerBackground()))?.viewerBackground ?? "mid")
      .then((value) => { if (alive) { setBackground(value); setBackgroundReady(true); } }, () => { /* A failed read must never write legacy cache over restored settings. */ });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!backgroundReady) return;
    rememberViewerBackground(background);
    void setViewerBackground(background).catch(() => {});
  }, [background, backgroundReady]);
  return [background, setBackground] as const;
}

/** 查看器 dock 的工具（从 Viewer 拆出）。 */
export function viewerDockItems(background: Background, inspectorOpen: boolean): DockItem[] {
return [
  { id: "fit", label: "适应窗口", icon: <Scan size={19} strokeWidth={1.75} />, shortcut: "0" },
  { id: "pixels", label: "原始像素", icon: <OneToOne />, shortcut: "1" },
  "sep",
  { id: "crop", label: "框选局部", icon: <CropIcon size={19} strokeWidth={1.75} />, shortcut: "F1" },
  { id: "pin", label: "钉住整图", icon: <Pin size={19} strokeWidth={1.75} />, shortcut: "P" },
  "sep",
  { id: "ground", label: "背景", icon: swatch(background), trayValue: background,
    tray: grounds.map((ground) => ({ id: ground, label: groundNames[ground], icon: swatch(ground) })) },
  { id: "inspector", label: inspectorOpen ? "隐藏详情" : "显示详情", icon: <PanelRight size={19} strokeWidth={1.75} />, shortcut: "I" },
];
}

/** 舞台上的位图：精确来源、替身与读取中 / 失败的说明（从 Viewer 拆出，#128）。 */
export function ViewerImages({ viewport, src, swapIn, setFailedSrc, placed, scale, ready, derived, setDerived, derivedMounted, derivedStandIn, lastStandIn, isOriginal, failed, setRetry }: {
  viewport: { width: number }; src: string; swapIn: (image: HTMLImageElement, loaded: string) => void; setFailedSrc: (src: string) => void;
  placed: CSSProperties; scale: number; ready: boolean; derived: { src: string; loaded: boolean } | null;
  setDerived: Dispatch<SetStateAction<{ src: string; loaded: boolean } | null>>; derivedMounted: boolean; derivedStandIn: boolean;
  lastStandIn: string | null; isOriginal: (address: string) => boolean; failed: boolean; setRetry: Dispatch<SetStateAction<number>>;
}) {
  return <>
    {viewport.width > 0 && <img key={src} className="viewer-image" src={src} alt="正在查看的参考图"
      draggable={false} onLoad={(e) => swapIn(e.currentTarget, src)} onError={() => setFailedSrc(src)}
      style={{ ...placed, imageRendering: scale > 2 ? "pixelated" : "auto", visibility: ready && !derivedStandIn ? "visible" : "hidden" }} />}
    {viewport.width > 0 && derivedMounted && derived && <img key={`derived:${derived.src}`} className="viewer-stand-in is-derived" src={derived.src} alt="" aria-hidden="true"
      draggable={false} onLoad={() => setDerived((d) => d?.src === derived.src ? { ...d, loaded: true } : d)}
      style={{ ...placed, visibility: derivedStandIn ? "visible" : "hidden" }} />}
    {viewport.width > 0 && lastStandIn && <img key={`last:${lastStandIn}`} className="viewer-stand-in" src={lastStandIn} alt="" aria-hidden="true"
      draggable={false} style={{ ...placed, imageRendering: scale > 2 && isOriginal(lastStandIn) ? "pixelated" : "auto" }} />}
    {failed ? <div className="viewer-message" role="alert">
      <p>无法读取这张参考图。请检查图库文件是否仍可访问。</p>
      <button type="button" className="k-btn is-sm" onClick={() => setRetry((r) => r + 1)}>重试读取</button>
    </div> : !ready && !derivedStandIn && !lastStandIn && <p className="viewer-message" role="status">正在读取参考图…</p>}
  </>;
}

/** 查看器右键菜单（#102 表“查看器”行，#114）：每项另有 dock 按钮或快捷键（从 Viewer 拆出）。 */
export function ViewerMenu({ pin, pinPart, copy, reveal, reset, background, setBackground, inspectorOpen, onToggleInspector, onTrash }: {
  pin: (region: Region | null) => void; pinPart: () => void; copy: () => void; reveal: () => void;
  reset: (next: "fit" | "pixels") => void; background: Background; setBackground: (background: Background) => void;
  inspectorOpen: boolean; onToggleInspector?: () => void; onTrash?: () => void;
}) {
  return (
  <MenuPopup label="查看器菜单" width={220}>
    <MenuItem icon={<Pin size={14} />} kbd="P" onClick={() => pin(null)}>钉住整图</MenuItem>
    <MenuItem icon={<CropIcon size={14} />} kbd="F1" onClick={pinPart}>钉住局部</MenuItem>
    <MenuItem icon={<Copy size={14} />} onClick={copy}>复制图片</MenuItem>
    <MenuSeparator />
    <MenuItem icon={<Scan size={14} />} kbd="0" onClick={() => reset("fit")}>适应窗口</MenuItem>
    <MenuItem icon={<OneToOne size={14} />} kbd="1" onClick={() => reset("pixels")}>原始像素</MenuItem>
    <MenuSubmenu icon={<Palette size={14} />} label="背景" popupLabel="背景">
      <Menu.RadioGroup value={background} onValueChange={(value) => setBackground(value as Background)}>
        {grounds.map((ground) => <MenuRadioItem key={ground} value={ground}>{groundNames[ground]}</MenuRadioItem>)}
      </Menu.RadioGroup>
    </MenuSubmenu>
    <MenuCheckboxItem checked={inspectorOpen} onCheckedChange={() => onToggleInspector?.()} kbd="I">详情</MenuCheckboxItem>
    <MenuSeparator />
    <MenuItem icon={<FolderSearch size={14} />} onClick={reveal}>在资源管理器中显示</MenuItem>
    {onTrash && <>
      <MenuSeparator />
      <MenuItem icon={<Trash2 size={14} />} danger onClick={onTrash}>移到回收站</MenuItem>
    </>}
  </MenuPopup>
  );
}
