import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageCard } from "../bindings/ImageCard";
import type { Region } from "../bindings/Region";
import { copyReferenceImage, imageDetail, workspaceImage, isUnknownImage, pinReference, revealReferenceImage } from "../ipc";
import type { KeyboardEvent } from "react";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { cropFromDrag, cropOnScreen, toScreenRect, type CssRect, type Point } from "./crop";
import { ArrowLeft, ChevronLeft, ChevronRight, Minus, Pin, Plus, RotateCcw, X } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useTranslation } from "react-i18next";
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import { Dock } from "../ui/Dock";
import { FollowDock } from "../ui/FollowDock";
import { OriginalStar } from "../ui/OriginalStar";
import { type Background, DOCK_RESERVE, useViewerBackground, viewerDockItems, ViewerImages, ViewerMenu } from "./ViewerParts";
import { useViewerSource } from "./useViewerSource";

type Props = {
  workspace?: boolean;
  libraryId: string;
  card: Omit<ImageCard, "thumbnail"> & Partial<Pick<ImageCard, "thumbnail">>;
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
  /** 旁边的详情侧栏是否显示着（#179）：I 键、dock 的“详情”与右键菜单的“详情”切换它。 */
  inspectorOpen?: boolean;
  onToggleInspector?: () => void;
};


/**
 * 查看器盖在图片墙所在的区域（#179），原位置与已加载的卡片保留；左侧栏、顶栏与旁边的详情侧栏照常可用。
 * 图片的信息与标签都在详情侧栏里，查看器不另放信息浮层；缩放比例在工具栏上。
 *
 * 钉到桌面（#65）：“钉住整图”，或 Shift+拖动（或先按“框选局部”）框出一块，按 Enter 或“钉住局部”。
 * 选区按原图像素记，标出“宽 × 高 原始像素”，缩放平移时边界不变。
 */
export function Viewer({ libraryId, card, onClose, reloadKey = 0, workspace = false, position, onStep, startCrop = false, onTrash, inspectorOpen = false, onToggleInspector }: Props) {
  const { t } = useTranslation(["viewer", "common"]);
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, left: 0, top: 0, dpr: window.devicePixelRatio || 1 });
  const [mode, setMode] = useState<"fit" | "pixels" | "zoom">("fit");
  const [zoomScale, setZoomScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [background, setBackground] = useViewerBackground();
  const drag = useRef<{ id: number; x: number; y: number; offset: typeof offset } | null>(null);
  /** 框选局部：选区（原图像素）、是否在框选模式、拖动中的起点（舞台上的 CSS 像素）。 */
  const [crop, setCrop] = useState<Region | null>(null);
  const [selecting, setSelecting] = useState(false);
  const select = useRef<{ id: number; start: Point } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pinStatus, setPinStatus] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const { dpr } = viewport;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
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
  const { loadedSrc, setLoadedSrc, derived, setDerived, failedSrc, setFailedSrc, setRetry, src, exactSource, isOriginal, ready, failed, derivedMounted, derivedStandIn, lastStandIn, swapIn } = useViewerSource({ libraryId, card, mode, physicalWidth });
  useLayoutEffect(() => root.current?.focus(), []);
  // A crop and an active gesture belong to one exact source, including same-sized images.
  useLayoutEffect(() => {
    setCrop(null);
    setSelecting(false);
    setDragging(false);
    setPinStatus(null);
    setLoadedSrc(null);
    setDerived(null);
    select.current = null;
    drag.current = null;
  }, [libraryId, card.id]);
  // 在上面的重置之后执行，只在打开时一次。
  useLayoutEffect(() => { if (startCrop) setSelecting(true); }, []);
  useCaptureSources(() => {
    const image = stage.current?.querySelector<HTMLImageElement>("img.viewer-image");
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
  const placed = { width, height, left: 0, top: 0, transform: `translate(${left}px, ${top}px)` };
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
      () => setPinStatus(region ? t("pinnedPart") : t("pinnedWhole")),
      (e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(t("common:image.pinFailed", { error: String(e) })); },
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
    copyReferenceImage(libraryId, card.id).then(() => setPinStatus(t("common:image.copied")),
      (e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(t("common:image.copyFailed", { error: String(e) })); });
  };
  const reveal = () => {
    setPinStatus(null);
    revealReferenceImage(libraryId, card.id).catch((e) => { if (isUnknownImage(e)) closeRef.current(); else setPinStatus(t("common:image.revealFailed", { error: String(e) })); });
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
        p: () => pin(null), P: () => pin(null), i: () => onToggleInspector?.(), I: () => onToggleInspector?.(),
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
  };
  const shownCropRect = cropRect && crop && !dragging ? cropRect : null;
  const viewerTools = viewerDockItems(background, inspectorOpen);
  const tool = (id: string, member?: string) => {
    if (id === "fit" || id === "pixels") reset(id);
    else if (id === "crop") toggleSelecting();
    else if (id === "pin") pin(null);
    else if (id === "ground" && member) setBackground(member as Background);
    else if (id === "inspector") onToggleInspector?.();
  };
  const cropTool = (id: string) => {
    if (id === "pin" && crop) pin(crop);
    else if (id === "redo") { setCrop(null); setSelecting(true); }
    else if (id === "cancel") cancelCrop();
  };
  const toolValue = selecting ? "crop" : mode === "zoom" ? null : mode;
  return (
    <section ref={root} className="viewer" role="region" aria-label={t("label")}
      tabIndex={-1} onKeyDown={keyDown}>
      <header className="viewer-bar">
        <button type="button" className="k-btn is-quiet viewer-back" aria-label={t("backLabel")} onClick={onClose}><ArrowLeft size={16} /><span className="k-label">{t("back")}</span></button>
        <span className="viewer-title" title={name ?? undefined}>{name}</span>
        {position && <>
          <span className="viewer-index">{position.index + 1} / {position.total}</span>
          <button type="button" className="k-icon-btn" aria-label={t("previous")} title={t("previousTitle")} disabled={position.index <= 0} onClick={() => onStep?.(-1)}><ChevronLeft size={16} /></button>
          <button type="button" className="k-icon-btn" aria-label={t("next")} title={t("nextTitle")} disabled={position.index >= position.total - 1} onClick={() => onStep?.(1)}><ChevronRight size={16} /></button>
        </>}
        <span className="k-grow" />
        <div className="viewer-zoom">
          <button type="button" className="k-icon-btn" aria-label={t("zoomOut")} title={t("zoomOut")} onClick={() => zoomAt(0.8)}><Minus size={15} /></button>
          <output aria-label={t("zoomLevel")}>{Math.round(physicalWidth / card.width * 100)}%</output>
          <button type="button" className="k-icon-btn" aria-label={t("zoomIn")} title={t("zoomIn")} onClick={() => zoomAt(1.25)}><Plus size={15} /></button>
        </div>
      </header>
      <ContextMenu.Root>
      <ContextMenu.Trigger render={<div className="viewer-stage" ref={stage} data-background={background}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current || select.current || (e.target as Element).closest("button, .k-dock")) return;
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
        <ViewerImages viewport={viewport} src={src} swapIn={swapIn} setFailedSrc={setFailedSrc} placed={placed} scale={scale} ready={ready}
          derived={derived} setDerived={setDerived} derivedMounted={derivedMounted} derivedStandIn={derivedStandIn} lastStandIn={lastStandIn}
          isOriginal={isOriginal} failed={failed} setRetry={setRetry} />
        {cropRect && crop && <div className="viewer-crop" aria-label={t("selection")}
          style={{ left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height }} />}
        {shownCropRect && crop && <FollowDock anchor={shownCropRect} bounds={viewport} reserveBottom={DOCK_RESERVE}>
          <Dock label={t("crop.label")} onSelect={cropTool} readout={<span className="k-original" title={t("originalPixels")}>{crop.width} × {crop.height}<span className="sr-only">{t("originalPixels")}</span><OriginalStar /></span>} items={[
            { id: "pin", label: t("common:image.pinPart"), icon: <Pin size={18} strokeWidth={1.9} />, shortcut: "Enter", tone: "primary" },
            { id: "redo", label: t("crop.redo"), icon: <RotateCcw size={18} strokeWidth={1.75} /> },
            { id: "cancel", label: t("crop.cancel"), icon: <X size={18} strokeWidth={1.75} />, shortcut: "Esc", tone: "danger" },
          ]} />
        </FollowDock>}
        {pinStatus && <p className="viewer-pin-status" role="status">{pinStatus}</p>}
        <div className="viewer-dock"><Dock label={t("tools.label")} items={viewerTools} value={toolValue} onSelect={tool} /></div>
      </ContextMenu.Trigger>
      {/* 查看器右键菜单（#102 表“查看器”行，#114）：每项另有 dock 按钮或快捷键。 */}
      <ViewerMenu pin={pin} pinPart={pinPart} copy={copy} reveal={reveal} reset={reset} background={background} setBackground={setBackground}
        inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector} onTrash={onTrash} />
      </ContextMenu.Root>
    </section>
  );
}
