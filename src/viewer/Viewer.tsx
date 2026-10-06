import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageCard } from "../bindings/ImageCard";
import { displayImageUrl } from "../ipc";
import type { KeyboardEvent } from "react";

type Props = { libraryId: string; card: ImageCard; onClose: () => void };
type Background = "dark" | "mid" | "light" | "checker";

function savedBackground(): Background {
  try {
    const saved = localStorage.getItem("kinshoko.viewer.background");
    if (saved === "dark" || saved === "mid" || saved === "light" || saved === "checker") return saved;
  } catch { /* 本地存储不可用时用中灰。 */ }
  return "mid";
}

/** 查看器盖在图片墙上，原位置与已加载的卡片保留。 */
export function Viewer({ libraryId, card, onClose }: Props) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, dpr: window.devicePixelRatio || 1 });
  const [mode, setMode] = useState<"fit" | "pixels" | "zoom">("fit");
  const [zoomScale, setZoomScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [background, setBackground] = useState<Background>(savedBackground);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [requestedPx, setRequestedPx] = useState(card.width);
  const drag = useRef<{ id: number; x: number; y: number; offset: typeof offset } | null>(null);
  const { dpr } = viewport;
  useLayoutEffect(() => root.current?.focus(), []);
  useEffect(() => {
    try { localStorage.setItem("kinshoko.viewer.background", background); } catch { /* 仅不记住底色。 */ }
  }, [background]);
  useLayoutEffect(() => {
    const el = stage.current!;
    const sync = () => setViewport((prev) => {
      const next = { width: el.clientWidth, height: el.clientHeight, dpr: window.devicePixelRatio || 1 };
      return prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr ? prev : next;
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
  const left = Math.round(((viewport.width - width) / 2 + offset.x) * dpr) / dpr;
  const top = Math.round(((viewport.height - height) / 2 + offset.y) * dpr) / dpr;
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
  // 连续缩小时只在短暂静止后生成派生图；中间不让 Chromium 缩小旧位图。
  useEffect(() => {
    if (mode !== "zoom" || desiredPx === card.width) { setRequestedPx(desiredPx); return; }
    const timer = window.setTimeout(() => setRequestedPx(desiredPx), 120);
    return () => window.clearTimeout(timer);
  }, [desiredPx, mode, card.width]);
  const sourcePx = mode === "zoom" && desiredPx < card.width ? requestedPx : desiredPx;
  const exactSource = sourcePx === desiredPx;
  const src = displayImageUrl(libraryId, card.id, sourcePx) + (retry ? `?retry=${retry}` : "");
  const keyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
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
  return (
    <section ref={root} className="viewer" role="dialog" aria-modal="true" aria-label="原图查看器"
      tabIndex={-1} onKeyDown={keyDown}>
      <header className="viewer-toolbar">
        <button type="button" onClick={onClose}>返回图片墙</button>
        <button type="button" aria-pressed={mode === "fit"} onClick={() => reset("fit")}>适应窗口</button>
        <button type="button" aria-pressed={mode === "pixels"} onClick={() => reset("pixels")}>原图像素</button>
        <button type="button" aria-label="缩小" onClick={() => zoomAt(0.8)}>−</button>
        <button type="button" aria-label="放大" onClick={() => zoomAt(1.25)}>＋</button>
        <output aria-label="缩放比例">{Math.round(physicalWidth / card.width * 100)}%</output>
        <span>{card.width} × {card.height} px</span>
        <label className="viewer-background">背景
          <select aria-label="查看器背景" value={background} onChange={(e) => setBackground(e.target.value as Background)}>
            <option value="dark">深灰</option><option value="mid">中灰</option>
            <option value="light">浅灰</option><option value="checker">棋盘格</option>
          </select>
        </label>
      </header>
      <div className="viewer-stage" ref={stage} data-background={background}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current || (e.target as Element).closest("button")) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, offset };
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start || start.id !== e.pointerId) return;
          setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y });
        }}
        onPointerUp={(e) => { if (drag.current?.id === e.pointerId) drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onLostPointerCapture={() => { drag.current = null; }}>
        {viewport.width > 0 && <img key={src} src={src} alt="正在查看的参考图"
          draggable={false} onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)}
          style={{ width, height, left, top, imageRendering: scale > 2 ? "pixelated" : "auto", visibility: exactSource && loadedSrc === src ? "visible" : "hidden" }} />}
        {exactSource && failedSrc === src ? <div className="viewer-message" role="alert">
          <p>无法读取这张参考图。请检查资料库文件是否仍可访问。</p>
          <button type="button" onClick={() => setRetry((r) => r + 1)}>重试读取</button>
        </div> : (!exactSource || loadedSrc !== src) && <p className="viewer-message" role="status">正在读取参考图…</p>}
      </div>
      <footer className="viewer-hint">滚轮缩放 · 拖动平移 · Esc 返回图片墙</footer>
    </section>
  );
}
