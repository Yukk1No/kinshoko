import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/** 详情面板的宽度（#157）：没拖过时 320，可拖到 280–560，同时不超过窗口宽度的一半。 */
export const INSPECTOR_WIDTH = { initial: 320, min: 280, max: 560 } as const;
const STEP = 16;

/** 窗口允许的最大宽度。 */
const widest = (viewport = window.innerWidth) => Math.min(INSPECTOR_WIDTH.max, Math.floor(viewport / 2));

/** 把宽度收进 280–560 与窗口一半之内；窗口太窄时以窗口一半为准。 */
export function clampInspectorWidth(width: number, viewport = window.innerWidth): number {
  return Math.min(Math.max(Math.round(width), INSPECTOR_WIDTH.min), widest(viewport));
}

/** 保存的宽度在当前窗口里实际用的宽度；窗口变窄时跟着收进上限。 */
export function useInspectorWidth(saved: number | undefined): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return clampInspectorWidth(saved ?? INSPECTOR_WIDTH.initial, viewport);
}

type Props = {
  width: number;
  /** done 为假是拖动中的预览；松手、双击、方向键时为真，调用方据此保存并让图片墙重排。 */
  onResize: (width: number, done: boolean) => void;
};

/**
 * 详情面板左边缘的拖动手柄（#157）。往左拖变宽；双击回到 320；聚焦后左右方向键每次 16px。
 */
export function InspectorResizer({ width, onResize }: Props) {
  const drag = useRef<{ x: number; width: number; pointer: number; last: number } | null>(null);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width, pointer: e.pointerId, last: width };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const next = clampInspectorWidth(d.width + d.x - e.clientX);
    if (next === d.last) return;
    d.last = next;
    onResize(next, false);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    onResize(d.last, true);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
    if (!delta) return;
    e.preventDefault();
    onResize(clampInspectorWidth(width + delta), true);
  };
  return (
    <div
      className="insp-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情宽度"
      title="拖动调整宽度，双击恢复默认"
      aria-valuenow={width}
      aria-valuemin={INSPECTOR_WIDTH.min}
      aria-valuemax={widest()}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onResize(INSPECTOR_WIDTH.initial, true)}
      onKeyDown={key}
    />
  );
}
