// Ctrl+滚轮缩放（#111）与鼠标滚轮插值（#109），从 Wall.tsx 原样搬出。
import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { cardAt, type masonry } from "./layout";
import { ZOOM_COMMIT_MS, createNotchCounter, zoomDensity } from "./zoom";
import { createSmoothWheel } from "./smoothWheel";

export type ZoomState = { value: number | null; timer: number; count: ReturnType<typeof createNotchCounter>; pin: { id: string; x: number; y: number } | null };
export type LiveWall = {
  layout: ReturnType<typeof masonry> | null; ids: string[]; density: number; previewDensity: number | null;
  onDensityPreview?: (value: number | null) => void; onDensityCommit?: (value: number) => void;
};

export function useWallZoom({ scroller, zoom, live, smoothRef, zoomPin, setPreviewDensity, measureBeforeReflow }: {
  scroller: MutableRefObject<HTMLDivElement | null>;
  zoom: MutableRefObject<ZoomState>;
  live: MutableRefObject<LiveWall>;
  smoothRef: MutableRefObject<ReturnType<typeof createSmoothWheel> | null>;
  zoomPin: MutableRefObject<{ id: string; pointerY: number } | null>;
  setPreviewDensity: Dispatch<SetStateAction<number | null>>;
  measureBeforeReflow: (keepSafe?: boolean) => void;
}) {
  // Ctrl+滚轮缩放（#111）。React 的 onWheel 是被动监听，不能阻止 WebView 的页面缩放，所以手动加。
  useEffect(() => {
    const el = scroller.current!;
    const z = zoom.current;
    const commit = () => {
      const value = z.value;
      clearTimeout(z.timer);
      z.value = null;
      z.pin = null;
      z.count = createNotchCounter();
      if (value === null) return;
      const { density, onDensityPreview, onDensityCommit } = live.current;
      if (value === density) {
        setPreviewDensity(null);
        onDensityPreview?.(null);
      } else {
        onDensityCommit?.(value);
      }
    };
    // 鼠标滚轮插值与惯性（#109）；Ctrl 的滚轮留给下面的缩放。
    const smooth = createSmoothWheel(el, { limit: () => Math.max(0, (live.current.layout?.height ?? 0) - el.clientHeight) });
    smoothRef.current = smooth;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      smooth.stop();
      const notches = z.count(e);
      if (!notches) return;
      clearTimeout(z.timer);
      z.timer = window.setTimeout(commit, ZOOM_COMMIT_MS);
      const { layout, ids, density, previewDensity, onDensityPreview } = live.current;
      const from = z.value ?? previewDensity ?? density;
      const next = zoomDensity(from, notches);
      if (next === from || !layout) return;
      z.value = next;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // 同一次连续缩放里光标没动就一直锚同一张图，不因落到缝隙而换图。
      if (!z.pin || Math.hypot(z.pin.x - x, z.pin.y - y) > 2) {
        const i = cardAt(layout, x + el.scrollLeft, y + el.scrollTop);
        z.pin = i >= 0 ? { id: ids[i], x, y } : null;
      }
      zoomPin.current = z.pin ? { id: z.pin.id, pointerY: y } : null;
      measureBeforeReflow();
      flushSync(() => setPreviewDensity(next));
      onDensityPreview?.(next);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      smooth.dispose();
      smoothRef.current = null;
      // 缩放停手前离开（换范围重建图片墙）也落下画师选的大小。
      if (z.value !== null) commit();
    };
  }, [measureBeforeReflow]);
}
