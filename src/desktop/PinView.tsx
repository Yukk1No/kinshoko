import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { SavedPin } from "../bindings/SavedPin";
import {
  captureUrl,
  movePin,
  onPinNotice,
  pinInfo,
  pinMenu,
  pinReady,
  turnPin,
  zoomPin,
  type PinTurn,
} from "../ipc";
import {
  cornerZoomScale,
  inZoomCorner,
  pinCanvasSize,
  pinDrawing,
  wheelZoomScale,
  type ZoomStart,
} from "./pixels";

/**
 * 钉图的 2D 画布：sRGB 色彩空间，优先用 float16 后备存储。
 *
 * 在开发机（110%，sRGB 显示器配置文件）上实测：sRGB 画布（8 位或 float16）与 <img> 回显逐像素
 * 一致；display-p3 画布即使是 float16 也有约一半像素偏差 1～8 级，不满足截图恒等，所以不用 P3。
 * float16 的 sRGB 画布是扩展范围的，广色域显示器的颜色不会被裁到 sRGB 色域；不支持时退回 8 位。
 */
function pinContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const wide = canvas.getContext("2d", {
    colorSpace: "srgb",
    colorType: "float16",
  } as CanvasRenderingContext2DSettings);
  const attributes = wide?.getContextAttributes() as { colorType?: string } | undefined;
  if (wide && attributes?.colorType === "float16") return wide;
  // 同一块 canvas 只能取一次 context，换一块再取普通画布。
  const fallback = document.createElement("canvas");
  canvas.replaceWith(fallback);
  fallback.className = canvas.className;
  return fallback.getContext("2d", { colorSpace: "srgb" });
}

/** 按 DPI 像素规则画钉图：canvas 后备尺寸等于窗口物理像素；先翻转再绕中心旋转，只画裁切部分。 */
function drawPin(ctx: CanvasRenderingContext2D, image: HTMLImageElement, pin: SavedPin) {
  const geometry = { width: pin.width, height: pin.height, ...pin.placement };
  const size = pinCanvasSize(geometry, window.devicePixelRatio);
  const drawing = pinDrawing(geometry);
  const c = ctx.canvas;
  c.width = size.width;
  c.height = size.height;
  c.style.width = `${size.cssWidth}px`;
  c.style.height = `${size.cssHeight}px`;
  c.style.imageRendering = size.pixelated ? "pixelated" : "auto";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate(drawing.angle);
  ctx.scale(drawing.flipX, drawing.flipY);
  const crop = pin.crop ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    -drawing.width / 2,
    -drawing.height / 2,
    drawing.width,
    drawing.height,
  );
}

/** 只发最新的一次：上一次还没返回时，新的请求替换排队中的那个。拖动时不会积压 IPC。 */
function latestOnly<A extends unknown[]>(send: (...args: A) => Promise<unknown>) {
  let busy = false;
  let queued: A | null = null;
  const run = (...args: A) => {
    if (busy) {
      queued = args;
      return;
    }
    busy = true;
    void send(...args)
      .catch(() => {})
      .finally(() => {
        busy = false;
        if (queued) {
          const next = queued;
          queued = null;
          run(...next);
        }
      });
  };
  return run;
}

type Gesture =
  | { kind: "move"; pointerId: number; screenX: number; screenY: number; origin: Promise<{ x: number; y: number }> }
  | { kind: "zoom"; pointerId: number; screenX: number; screenY: number; start: ZoomStart };

const TURN_KEYS: Record<string, PinTurn> = {
  h: "flipHorizontal",
  v: "flipVertical",
  r: "rotateClockwise",
  R: "rotateCounterClockwise",
};

/**
 * 钉图窗口：按 DPI 像素规则把截图画在物理像素尺寸的 canvas 上（未缩放时与截图逐像素一致）。
 *
 * 笔、鼠标与触摸走同一套 pointer 处理（#7：Windows Ink 下笔拖动没有系统拖动需要的鼠标事件）：
 * 按住拖动移动，按住右下角拖动缩放，都由程序移动窗口。滚轮以光标为中心缩放；H/V 翻转，R/Shift+R
 * 旋转。右键弹出菜单。
 */
export function PinView({ pin }: { pin: string }) {
  const host = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const current = useRef<SavedPin | null>(null);
  const redraw = useRef<(p: SavedPin) => void>(() => {});
  const [corner, setCorner] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const onResize = () => current.current && redraw.current(current.current);
    (async () => {
      const info = await pinInfo(pin);
      if (!info || !alive) return;
      if (info.content.kind !== "capture") return;
      const image = new Image();
      image.src = captureUrl(info.content.captureId);
      await image.decode();
      if (!alive || !host.current) return;
      const canvas = document.createElement("canvas");
      canvas.className = "pin-canvas";
      host.current.prepend(canvas);
      const ctx = pinContext(canvas);
      if (!ctx) return;
      redraw.current = (p) => {
        current.current = p;
        drawPin(ctx, image, p);
      };
      redraw.current(info);
      // 拖到缩放比例不同的显示器上时，按新的 dpr 重定 CSS 尺寸。
      window.addEventListener("resize", onResize);
      await pinReady(pin);
    })();
    const unlisten = onPinNotice((text) => setNotice(text));
    return () => {
      alive = false;
      window.removeEventListener("resize", onResize);
      void unlisten.then((stop) => stop());
    };
  }, [pin]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [notice]);

  // 发往应用壳的拖动与缩放，只保留最新的一次。
  const send = useRef({
    move: latestOnly((x: number, y: number) => movePin(pin, x, y)),
    zoom: latestOnly((scale: number, ax: number, ay: number) =>
      zoomPin(pin, scale, ax, ay).then((p) => redraw.current(p)),
    ),
  });

  // 滚轮缩放（React 的 onWheel 是被动监听，不能阻止页面缩放，所以手动加）。
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let target: number | null = null;
    let idle = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = current.current;
      if (!p || gesture.current) return;
      const dpr = window.devicePixelRatio;
      target = wheelZoomScale(target ?? p.placement.scale, e.deltaY);
      send.current.zoom(target, e.clientX * dpr, e.clientY * dpr);
      clearTimeout(idle);
      idle = window.setTimeout(() => (target = null), 300);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 不让 WebView 自己缩放页面。
      if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const turn = TURN_KEYS[e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()];
      if (!turn) return;
      e.preventDefault();
      void turnPin(pin, turn).then((p) => redraw.current(p));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pin]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = { pointerId: e.pointerId, screenX: e.screenX, screenY: e.screenY };
    const p = current.current;
    if (p && inZoomCorner({ x: e.clientX, y: e.clientY }, window.innerWidth, window.innerHeight)) {
      const size = pinCanvasSize({ width: p.width, height: p.height, ...p.placement }, 1);
      gesture.current = { kind: "zoom", ...base, start: { scale: p.placement.scale, ...size } };
    } else {
      gesture.current = { kind: "move", ...base, origin: getCurrentWindow().outerPosition() };
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) {
      setCorner(inZoomCorner({ x: e.clientX, y: e.clientY }, window.innerWidth, window.innerHeight));
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    const dpr = window.devicePixelRatio;
    const dx = (e.screenX - g.screenX) * dpr;
    const dy = (e.screenY - g.screenY) * dpr;
    if (g.kind === "move") {
      void g.origin.then((o) => send.current.move(Math.round(o.x + dx), Math.round(o.y + dy)));
    } else {
      send.current.zoom(cornerZoomScale(g.start, dx, dy), 0, 0);
    }
  };
  const endGesture = (e: PointerEvent) => {
    if (gesture.current?.pointerId === e.pointerId) gesture.current = null;
  };

  return (
    <div
      ref={host}
      className={corner ? "pin pin-corner" : "pin"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onContextMenu={(e) => {
        e.preventDefault();
        void pinMenu(pin);
      }}
    >
      <div className="pin-appear" aria-hidden />
      {notice && <div className="pin-notice">{notice}</div>}
    </div>
  );
}
