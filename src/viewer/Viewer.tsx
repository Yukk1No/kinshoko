import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageCard } from "../bindings/ImageCard";
import type { Region } from "../bindings/Region";
import { copyReferenceImage, displayScaledUrl, displayUrl, imageDetail, workspaceImage, isUnknownImage, pinReference, revealReferenceImage, shellSettings, migrateViewerBackground, setViewerBackground } from "../ipc";
import { legacyViewerBackground, rememberViewerBackground } from "./background";
import type { KeyboardEvent } from "react";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { cropFromDrag, cropOnScreen, toScreenRect, type CssRect, type Point } from "./crop";
import { ArrowLeft, ChevronLeft, ChevronRight, Copy, Crop as CropIcon, FolderSearch, Info, Minus, Palette, Pin, Plus, RotateCcw, Scan, Trash2, X } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuRadioItem, MenuSeparator, MenuSubmenu } from "../ui/Menu";
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import { Dock, type DockItem } from "../ui/Dock";
import { FollowDock } from "../ui/FollowDock";
import { WinCtrls } from "../ui/WinCtrls";

type Props = {
  workspace?: boolean;
  sourceName?: string;
  libraryId: string;
  card: ImageCard;
  onClose: () => void;
  /** 资料库报告列表过期时递增：重新确认这张图还在（可能被删除或被安全模式封印）。 */
  reloadKey?: number;
  /** 这张图在当前浏览结果里的位置（从 0 起）；给出时标题行显示序号与上一张 / 下一张。 */
  position?: { index: number; total: number };
  /** 换到上一张（-1）或下一张（1）。 */
  onStep?: (delta: -1 | 1) => void;
  /** 打开时即进入框选（图片墙右键“框选局部钉住”或 F1）；换到别的图后不再自动框选。 */
  startCrop?: boolean;
  /** 右键菜单“移到回收站”（#114）；不给出时（例如正在看回收站里的图）菜单里没有这一项。 */
  onTrash?: () => void;
};
type Background = "dark" | "mid" | "light" | "checker";
const grounds: Background[] = ["dark", "mid", "light", "checker"];
const groundNames: Record<Background, string> = { dark: "深灰", mid: "中灰", light: "浅灰", checker: "棋盘格" };
/** 查看器 dock 底部留给自己的高度，框选 dock 不压在它上面。 */
const DOCK_RESERVE = 76;
const swatch = (ground: Background) => <span className="viewer-swatch" data-ground={ground} aria-hidden="true" />;
const OneToOne = ({ size = 19 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M8.5 10v5M8 10.5l.5-.5M15.5 10v5M15 10.5l.5-.5" /><path d="M12 11.2v.1M12 14v.1" /></svg>;


/**
 * 查看器盖在图片墙上，原位置与已加载的卡片保留。
 *
 * 钉到桌面（#65）：“钉住整图”，或 Shift+拖动（或先按“框选局部”）框出一块，按 Enter 或“钉住局部”。
 * 选区按原图像素记，标出“宽 × 高 原始像素”，缩放平移时边界不变。
 */
export function Viewer({ libraryId, card, onClose, reloadKey = 0, workspace = false, sourceName, position, onStep, startCrop = false, onTrash }: Props) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, left: 0, top: 0, dpr: window.devicePixelRatio || 1 });
  const [mode, setMode] = useState<"fit" | "pixels" | "zoom">("fit");
  const [zoomScale, setZoomScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [background, setBackground] = useState<Background>(legacyViewerBackground);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [requestedPx, setRequestedPx] = useState(card.width);
  const drag = useRef<{ id: number; x: number; y: number; offset: typeof offset } | null>(null);
  /** 框选局部：选区（原图像素）、是否在框选模式、拖动中的起点（舞台上的 CSS 像素）。 */
  const [crop, setCrop] = useState<Region | null>(null);
  const [selecting, setSelecting] = useState(false);
  const select = useRef<{ id: number; start: Point } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pinStatus, setPinStatus] = useState<string | null>(null);
  const [info, setInfo] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const { dpr } = viewport;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => root.current?.focus(), []);
  // A crop and an active gesture belong to one exact source, including same-sized images.
  useLayoutEffect(() => {
    setCrop(null);
    setSelecting(false);
    setDragging(false);
    setPinStatus(null);
    select.current = null;
    drag.current = null;
  }, [libraryId, card.id]);
  // 在上面的重置之后执行，只在打开时一次。
  useLayoutEffect(() => { if (startCrop) setSelecting(true); }, []);
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
  useLayoutEffect(() => {
    const el = stage.current!;
    const sync = () => setViewport((prev) => {
      const rect = el.getBoundingClientRect();
      const next = { width: el.clientWidth, height: el.clientHeight, left: rect.left, top: rect.top, dpr: window.devicePixelRatio || 1 };
      return prev.width === next.width && prev.height === next.height && prev.left === next.left && prev.top === next.top && prev.dpr === next.dpr ? prev : next;
    });
    sync();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    ro?.observe(el);
    window.addEventListener("resize", sync);
    const resolution = window.matchMedia?.(`(resolution: ${dpr}dppx)`);
    resolution?.addEventListener("change", sync);
    return () => { ro?.disconnect(); window.removeEventListener("resize", sync); resolution?.removeEventListener("change", sync); };
  }, [dpr]);
  const fitWidth = Math.min(card.width, Math.floor(viewport.width * dpr), Math.floor(Math.floor(viewport.height * dpr) * card.width / card.height));
  const physicalWidth = Math.max(1, mode === "fit" ? fitWidth : Math.round(card.width * (mode === "pixels" ? 1 : zoomScale)));
  const physicalHeight = Math.max(1, Math.round(card.height * physicalWidth / card.width));
  const width = physicalWidth / dpr;
  const height = physicalHeight / dpr;
  // 工具栏本身可落在部分设备像素上，起点必须相对整个窗口对齐，再换回观察层坐标。
  const left = Math.round((viewport.left + (viewport.width - width) / 2 + offset.x) * dpr) / dpr - viewport.left;
  const top = Math.round((viewport.top + (viewport.height - height) / 2 + offset.y) * dpr) / dpr - viewport.top;
  const scale = physicalWidth / card.width;
  const reset = (next: "fit" | "pixels") => { setMode(next); setOffset({ x: 0, y: 0 }); };
  const zoomAt = (factor: number, x = viewport.width / 2, y = viewport.height / 2) => {
    const next = Math.min(32, Math.max(1 / card.width, scale * factor));
    const nextWidth = Math.max(1, Math.round(card.width * next));
    const nextHeight = Math.max(1, Math.round(card.height * nextWidth / card.width));
    setMode("zoom");
    setZoomScale(next);
    setOffset({
      x: x - (x - left) / width * (nextWidth / dpr) - (viewport.width - nextWidth / dpr) / 2,
      y: y - (y - top) / height * (nextHeight / dpr) - (viewport.height - nextHeight / dpr) / 2,
    });
  };
  useEffect(() => {
    const el = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
      zoomAt(Math.exp(-Math.max(-600, Math.min(600, event.deltaY * unit)) * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  const desiredPx = Math.min(physicalWidth, card.width);
  const sourcePx = mode === "zoom" && desiredPx < card.width ? requestedPx : desiredPx;
  const exactSource = sourcePx === desiredPx;
  // 1:1 与放大走 Library::display（原图或原尺寸 sdr 派生图）；缩小走精确尺寸派生图。从不直接读原文件。
  const address = sourcePx >= card.width ? displayUrl(libraryId, card.id) : displayScaledUrl(libraryId, card.id, sourcePx);
  const src = address + (retry ? `?retry=${retry}` : "");
  // WebView2 不取消被换掉的请求，每张派生图都要整图解码；同一时刻只等一张，否则快速缩放时积压，迟迟出不了图。
  const derivativePending = sourcePx < card.width && loadedSrc !== src && failedSrc !== src;
  // 连续缩小时只在短暂静止后生成派生图；中间不让 Chromium 缩小旧位图。
  useEffect(() => {
    if (mode !== "zoom" || desiredPx === card.width) { setRequestedPx(desiredPx); return; }
    if (derivativePending) return;
    const timer = window.setTimeout(() => setRequestedPx(desiredPx), 120);
    return () => window.clearTimeout(timer);
  }, [desiredPx, mode, card.width, derivativePending]);
  useCaptureSources(() => {
    const image = stage.current?.querySelector("img");
    if (!image || !exactSource || loadedSrc !== src || failedSrc === src) return [];
    const reference = captureImage(image, stage.current!, libraryId, card.id, card.width, card.height);
    return reference ? [reference] : [];
  }, 100);
  // 这张图已不在（被删除，或安全模式下被封印，查询返回 UnknownImage）时回到图片墙。
  useEffect(() => {
    let alive = true;
    (workspace ? workspaceImage : imageDetail)(libraryId, card.id).then(
      (detail) => { if (alive) setName(detail?.originalName ?? null); },
      (e) => { if (alive && isUnknownImage(e)) closeRef.current(); });
    return () => { alive = false; };
  }, [libraryId, card.id, reloadKey, failedSrc, workspace]);
  const shown = { left, top, width, height };
  const natural = { width: card.width, height: card.height };
  const cropRect = crop && cropOnScreen(crop, shown, natural);
  /** 舞台上的点（CSS 像素）。 */
  const stagePoint = (e: { clientX: number; clientY: number }): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  /** 钉到桌面：整图（crop 为 null）或选区；钉图以它此刻在查看器里的位置为中心出现。 */
  const pin = (region: Region | null) => {
    const rect: CssRect = region ? cropOnScreen(region, shown, natural) : { x: left, y: top, width, height };
    setPinStatus(null);
    pinReference(libraryId, card.id, region, toScreenRect(rect, viewport, dpr)).then(
      () => setPinStatus(region ? "已钉住局部" : "已钉住整图"),
      (e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(`无法钉住：${String(e)}`); },
    );
  };
  useEffect(() => {
    if (!pinStatus) return;
    const timer = window.setTimeout(() => setPinStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [pinStatus]);
  /** 复制图片、在资源管理器中显示（#105 的命令，#114 的查看器菜单）：结果在钉图提示的位置说明。 */
  const copy = () => {
    setPinStatus(null);
    copyReferenceImage(libraryId, card.id).then(() => setPinStatus("已复制图片"),
      (e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(`无法复制图片：${String(e)}`); });
  };
  const reveal = () => {
    setPinStatus(null);
    revealReferenceImage(libraryId, card.id).catch((e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(`无法在资源管理器中显示：${String(e)}`); });
  };
  /** 钉住局部：已有选区就钉住它，否则进入框选。 */
  const pinPart = () => { if (crop) pin(crop); else setSelecting(true); };
  const cancelCrop = () => { setCrop(null); setSelecting(false); setDragging(false); select.current = null; };
  const toggleSelecting = () => setSelecting((on) => !on);
  const keyDown = (e: KeyboardEvent<HTMLElement>) => {
    // 右键菜单渲染在 portal 里，按键仍沿 React 树冒泡到这里：菜单里的按键归菜单处理。
    if ((e.target as Element).closest?.("[role='menu']")) return;
    if (isMenuKey(e)) {
      e.preventDefault(); e.stopPropagation();
      if (stage.current) openMenuAt(stage.current);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      // 先取消框选，再回到图片墙。
      if (crop || selecting) cancelCrop(); else onClose();
      return;
    }
    // dock 的快捷键与点按 dock 走同一处理；方向键在 dock 内只移动焦点。
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const inDock = !!(e.target as Element).closest?.(".k-dock");
      const shortcut: Record<string, () => void> = {
        "0": () => reset("fit"), "1": () => reset("pixels"), F1: toggleSelecting,
        p: () => pin(null), P: () => pin(null), i: () => setInfo((on) => !on), I: () => setInfo((on) => !on),
      };
      if (shortcut[e.key]) { e.preventDefault(); shortcut[e.key](); return; }
      if (!inDock && position && onStep && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const delta = e.key === "ArrowLeft" ? -1 : 1;
        const next = position.index + delta;
        if (next >= 0 && next < position.total) onStep(delta);
        return;
      }
    }
    if (e.key === "Enter" && crop && !(e.target as Element).closest?.("button, select")) {
      e.preventDefault(); pin(crop); return;
    }
    if (e.key === "Tab") {
      const controls = [...root.current!.querySelectorAll<HTMLElement>("button:not(:disabled), select")];
      const first = controls[0];
      const last = controls.at(-1)!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === root.current)) {
        e.preventDefault(); first.focus();
      }
    }
  };
  const shownCropRect = cropRect && crop && !dragging ? cropRect : null;
  const viewerTools: DockItem[] = [
    { id: "fit", label: "适应窗口", icon: <Scan size={19} strokeWidth={1.75} />, shortcut: "0" },
    { id: "pixels", label: "原始像素", icon: <OneToOne />, shortcut: "1" },
    "sep",
    { id: "crop", label: "框选局部", icon: <CropIcon size={19} strokeWidth={1.75} />, shortcut: "F1" },
    { id: "pin", label: "钉住整图", icon: <Pin size={19} strokeWidth={1.75} />, shortcut: "P" },
    "sep",
    { id: "ground", label: "背景", icon: swatch(background), trayValue: background,
      tray: grounds.map((ground) => ({ id: ground, label: groundNames[ground], icon: swatch(ground) })) },
    { id: "info", label: "信息", icon: <Info size={19} strokeWidth={1.75} />, shortcut: "I" },
  ];
  const tool = (id: string, member?: string) => {
    if (id === "fit" || id === "pixels") reset(id);
    else if (id === "crop") toggleSelecting();
    else if (id === "pin") pin(null);
    else if (id === "ground" && member) setBackground(member as Background);
    else if (id === "info") setInfo((on) => !on);
  };
  const cropTool = (id: string) => {
    if (id === "pin" && crop) pin(crop);
    else if (id === "redo") { setCrop(null); setSelecting(true); }
    else if (id === "cancel") cancelCrop();
  };
  const toolValue = selecting ? "crop" : mode === "zoom" ? null : mode;
  return (
    <section ref={root} className="viewer" role="dialog" aria-modal="true" aria-label="原图查看器"
      tabIndex={-1} onKeyDown={keyDown}>
      <header className="viewer-bar" data-tauri-drag-region>
        <button type="button" className="k-btn is-quiet viewer-back" aria-label="返回图片墙" onClick={onClose}><ArrowLeft size={16} />返回</button>
        <span className="viewer-title" title={name ?? undefined} data-tauri-drag-region>{name}</span>
        {position && <>
          <span className="viewer-index" data-tauri-drag-region>{position.index + 1} / {position.total}</span>
          <button type="button" className="k-icon-btn" aria-label="上一张" title="上一张 ←" disabled={position.index <= 0} onClick={() => onStep?.(-1)}><ChevronLeft size={16} /></button>
          <button type="button" className="k-icon-btn" aria-label="下一张" title="下一张 →" disabled={position.index >= position.total - 1} onClick={() => onStep?.(1)}><ChevronRight size={16} /></button>
        </>}
        <span className="k-grow" data-tauri-drag-region />
        <div className="viewer-zoom">
          <button type="button" className="k-icon-btn" aria-label="缩小" title="缩小" onClick={() => zoomAt(0.8)}><Minus size={15} /></button>
          <output aria-label="缩放比例">{Math.round(physicalWidth / card.width * 100)}%</output>
          <button type="button" className="k-icon-btn" aria-label="放大" title="放大" onClick={() => zoomAt(1.25)}><Plus size={15} /></button>
        </div>
        <WinCtrls />
      </header>
      <ContextMenu.Root>
      <ContextMenu.Trigger render={<div className="viewer-stage" ref={stage} data-background={background}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current || select.current || (e.target as Element).closest("button, .k-dock, .viewer-info")) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          if (e.shiftKey || selecting) {
            select.current = { id: e.pointerId, start: stagePoint(e) };
            setDragging(true);
            return;
          }
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, offset };
        }}
        onPointerMove={(e) => {
          const s = select.current;
          if (s && s.id === e.pointerId) {
            const next = cropFromDrag(s.start, stagePoint(e), shown, natural);
            if (next) setCrop(next);
            return;
          }
          const start = drag.current;
          if (!start || start.id !== e.pointerId) return;
          setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y });
        }}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId) drag.current = null;
          if (select.current?.id === e.pointerId) { select.current = null; setSelecting(false); setDragging(false); }
        }}
        onPointerCancel={() => { drag.current = null; select.current = null; setDragging(false); }}
        onLostPointerCapture={() => { drag.current = null; select.current = null; setDragging(false); }} />}>
        {viewport.width > 0 && <img key={src} src={src} alt="正在查看的参考图"
          draggable={false} onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)}
          style={{ width, height, left: 0, top: 0, transform: `translate(${left}px, ${top}px)`, imageRendering: scale > 2 ? "pixelated" : "auto", visibility: exactSource && loadedSrc === src ? "visible" : "hidden" }} />}
        {exactSource && failedSrc === src ? <div className="viewer-message" role="alert">
          <p>无法读取这张参考图。请检查图库文件是否仍可访问。</p>
          <button type="button" className="k-btn is-sm" onClick={() => setRetry((r) => r + 1)}>重试读取</button>
        </div> : (!exactSource || loadedSrc !== src) && <p className="viewer-message" role="status">正在读取参考图…</p>}
        {cropRect && crop && <div className="viewer-crop" aria-label="选区"
          style={{ left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height }} />}
        {shownCropRect && crop && <FollowDock anchor={shownCropRect} bounds={viewport} reserveBottom={DOCK_RESERVE}>
          <Dock label="框选" onSelect={cropTool} readout={<><b>{crop.width} × {crop.height}</b>原始像素</>} items={[
            { id: "pin", label: "钉住局部", icon: <Pin size={18} strokeWidth={1.9} />, shortcut: "Enter", tone: "primary" },
            { id: "redo", label: "重选", icon: <RotateCcw size={18} strokeWidth={1.75} /> },
            { id: "cancel", label: "取消", icon: <X size={18} strokeWidth={1.75} />, shortcut: "Esc", tone: "danger" },
          ]} />
        </FollowDock>}
        {info && <section className="viewer-info" aria-label="图片信息">
          <dl>
            {name && <><dt>文件</dt><dd>{name}</dd></>}
            <dt>尺寸</dt><dd>{card.width} × {card.height} 原始像素</dd>
            <dt>缩放</dt><dd>{Math.round(physicalWidth / card.width * 100)}%</dd>
            {sourceName && <><dt>图库</dt><dd>{sourceName}</dd></>}
          </dl>
          <p>滚轮缩放 · 拖动平移 · Shift+拖动框选局部 · Esc 返回</p>
        </section>}
        {pinStatus && <p className="viewer-pin-status" role="status">{pinStatus}</p>}
        <div className="viewer-dock"><Dock label="查看工具" items={viewerTools} value={toolValue} onSelect={tool} /></div>
      </ContextMenu.Trigger>
      {/* 查看器右键菜单（#102 表“查看器”行，#114）：每项另有 dock 按钮或快捷键。 */}
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
        <MenuCheckboxItem checked={info} onCheckedChange={setInfo} kbd="I">信息</MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem icon={<FolderSearch size={14} />} onClick={reveal}>在资源管理器中显示</MenuItem>
        {onTrash && <>
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={14} />} danger onClick={onTrash}>移到回收站</MenuItem>
        </>}
      </MenuPopup>
      </ContextMenu.Root>
    </section>
  );
}
