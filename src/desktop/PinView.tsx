import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { captureUrl, movePin, onPinNotice, pinInfo, pinMenu, pinReady } from "../ipc";
import { pinCanvasSize } from "./pixels";

/**
 * 钉图的 2D 画布。优先用 display-p3 的 float16 画布：颜色在半精度浮点里转换，往返回到显示器时
 * 不损失 8 位精度，也不被裁到 sRGB 色域；不支持时退回普通 sRGB 画布。
 */
function pinContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const wide = canvas.getContext("2d", {
    colorSpace: "display-p3",
    colorType: "float16",
  } as CanvasRenderingContext2DSettings);
  const attributes = wide?.getContextAttributes() as { colorType?: string } | undefined;
  if (wide && attributes?.colorType === "float16") return wide;
  // 同一块 canvas 只能取一次 context，换一块再取普通画布。
  const fallback = document.createElement("canvas");
  canvas.replaceWith(fallback);
  fallback.className = canvas.className;
  return fallback.getContext("2d");
}

interface PenDrag {
  pointerId: number;
  screenX: number;
  screenY: number;
  origin: Promise<{ x: number; y: number }>;
  frame: number;
}

/**
 * 钉图窗口：按 DPI 像素规则把截图画在物理像素尺寸的 canvas 上（未缩放时与截图逐像素一致）。
 * 鼠标拖动走系统拖动；数位笔与触摸直接处理 pointer 事件、由程序移动窗口（#7：Windows Ink 下
 * 没有系统拖动需要的鼠标事件）。右键弹出菜单。
 */
export function PinView({ pin }: { pin: string }) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<PenDrag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let draw = () => {};
    (async () => {
      const info = await pinInfo(pin);
      if (!info || !alive) return;
      const image = new Image();
      image.src = captureUrl(info.captureId);
      await image.decode();
      if (!alive || !host.current) return;
      const canvas = document.createElement("canvas");
      canvas.className = "pin-canvas";
      host.current.prepend(canvas);
      const ctx = pinContext(canvas);
      if (!ctx) return;
      draw = () => {
        const dpr = window.devicePixelRatio;
        const size = pinCanvasSize({ width: info.width, height: info.height, scale: 1, rotation: 0 }, dpr);
        const c = ctx.canvas;
        c.width = size.width;
        c.height = size.height;
        c.style.width = `${size.cssWidth}px`;
        c.style.height = `${size.cssHeight}px`;
        c.style.imageRendering = size.pixelated ? "pixelated" : "auto";
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, 0, 0, size.width, size.height);
      };
      draw();
      // 拖到缩放比例不同的显示器上时，按新的 dpr 重定 CSS 尺寸。
      window.addEventListener("resize", draw);
      await pinReady(pin);
    })();
    const unlisten = onPinNotice((text) => setNotice(text));
    return () => {
      alive = false;
      window.removeEventListener("resize", draw);
      void unlisten.then((stop) => stop());
    };
  }, [pin]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [notice]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.pointerType === "mouse") {
      void getCurrentWindow().startDragging();
      return;
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      screenX: e.screenX,
      screenY: e.screenY,
      origin: getCurrentWindow().outerPosition(),
      frame: 0,
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dpr = window.devicePixelRatio;
    const dx = (e.screenX - d.screenX) * dpr;
    const dy = (e.screenY - d.screenY) * dpr;
    cancelAnimationFrame(d.frame);
    d.frame = requestAnimationFrame(() => {
      void d.origin.then((o) => movePin(pin, Math.round(o.x + dx), Math.round(o.y + dy)));
    });
  };
  const endDrag = (e: PointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  return (
    <div
      ref={host}
      className="pin"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
