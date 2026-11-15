import { type MutableRefObject, type PointerEvent } from "react";
import type { Region } from "../bindings/Region";
import { cropFromDrag, type Point } from "./crop";

// 舞台上的指针手势（拖动平移、Shift+拖动框选），原样从 Viewer.tsx 移出。

type Args = {
  drag: MutableRefObject<{ id: number; x: number; y: number; offset: { x: number; y: number } } | null>;
  select: MutableRefObject<{ id: number; start: Point } | null>;
  selecting: boolean;
  stagePoint: (e: { clientX: number; clientY: number }) => Point;
  setDragging: (dragging: boolean) => void;
  setSelecting: (selecting: boolean) => void;
  shown: Parameters<typeof cropFromDrag>[2];
  natural: Parameters<typeof cropFromDrag>[3];
  setCrop: (crop: Region | null) => void;
  offset: { x: number; y: number };
  setOffset: (offset: { x: number; y: number }) => void;
};

export function stagePointerHandlers({
  drag,
  select,
  selecting,
  stagePoint,
  setDragging,
  setSelecting,
  shown,
  natural,
  setCrop,
  offset,
  setOffset,
}: Args) {
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || drag.current || select.current || (e.target as Element).closest("button, .k-dock")) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (e.shiftKey || selecting) {
        select.current = { id: e.pointerId, start: stagePoint(e) };
        setDragging(true);
        return;
      }
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, offset };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const s = select.current;
      if (s && s.id === e.pointerId) {
        const next = cropFromDrag(s.start, stagePoint(e), shown, natural);
        if (next) setCrop(next);
        return;
      }
      const start = drag.current;
      if (!start || start.id !== e.pointerId) return;
      setOffset({ x: start.offset.x + e.clientX - start.x, y: start.offset.y + e.clientY - start.y });
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
      if (select.current?.id === e.pointerId) {
        select.current = null;
        setSelecting(false);
        setDragging(false);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
      select.current = null;
      setDragging(false);
    },
    onLostPointerCapture: () => {
      drag.current = null;
      select.current = null;
      setDragging(false);
    },
  };
}
