import { useLayoutEffect, useState, type RefObject } from "react";

// 舞台的视口尺寸与设备像素比，原样从 Viewer.tsx 移出。

export function useViewerViewport(stage: RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState({ width: 0, height: 0, left: 0, top: 0, dpr: window.devicePixelRatio });
  const { dpr } = viewport;
  useLayoutEffect(() => {
    const el = stage.current!;
    const sync = () => setViewport((prev) => {
      const rect = el.getBoundingClientRect();
      const next = { width: el.clientWidth, height: el.clientHeight, left: rect.left, top: rect.top, dpr: window.devicePixelRatio };
      return prev.width === next.width && prev.height === next.height && prev.left === next.left && prev.top === next.top && prev.dpr === next.dpr ? prev : next;
    });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    const resolution = window.matchMedia(`(resolution: ${dpr}dppx)`);
    resolution.addEventListener("change", sync);
    return () => { ro.disconnect(); window.removeEventListener("resize", sync); resolution.removeEventListener("change", sync); };
  }, [dpr, stage]);
  return { viewport, dpr };
}
