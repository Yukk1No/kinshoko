// 离开查看器后接回图片墙上最后查看的那张（#179）。
import { useLayoutEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { masonry } from "./layout";
import type { createSmoothWheel } from "./smoothWheel";

export function useViewerLeave({ viewerOpen, selected, lastOpened, wasViewing, smoothRef }: {
  viewerOpen: boolean;
  selected: ReadonlySet<string>;
  lastOpened: MutableRefObject<string | null>;
  wasViewing: MutableRefObject<boolean>;
  smoothRef: MutableRefObject<ReturnType<typeof createSmoothWheel> | null>;
}) {

  // 查看中换图时选择跟着走（#179）：最后查看的就是选中的那张，它一直挂载着，返回时接回焦点。
  if (viewerOpen && selected.size === 1) lastOpened.current = selected.values().next().value!;
  /** 离开查看器后要滚入可见、接回焦点的卡片。 */
  const returnTo = useRef<string | null>(null);
  useLayoutEffect(() => {
    // 打开查看器时停下滚轮惯性，返回时图片墙仍在打开时的位置。
    if (viewerOpen) smoothRef.current?.stop();
    if (wasViewing.current && !viewerOpen && lastOpened.current) returnTo.current = lastOpened.current;
    wasViewing.current = viewerOpen;
  }, [viewerOpen]);
  return returnTo;
}

export function useReturnFocus({ returnTo, scroller, position, layout, syncMount }: {
  returnTo: MutableRefObject<string | null>;
  scroller: MutableRefObject<HTMLDivElement | null>;
  position: Map<string, number>;
  layout: ReturnType<typeof masonry>;
  syncMount: (el: HTMLElement) => void;
}) {
  // 离开查看器（#179）：最后查看的那张完全不在视口里（查看时换过图）就滚到视口中间，再接回焦点；
  // 还看得见时图片墙留在打开查看器时的位置。
  useLayoutEffect(() => {
    const id = returnTo.current, el = scroller.current;
    if (!id || !el) return;
    returnTo.current = null;
    const i = position.get(id);
    const box = i === undefined ? undefined : layout.boxes[i];
    if (box && el.clientHeight > 0 && (box.y + box.h <= el.scrollTop || box.y >= el.scrollTop + el.clientHeight)) {
      el.scrollTop = Math.max(0, box.y - Math.max(0, (el.clientHeight - box.h) / 2));
      syncMount(el);
    }
    el.querySelector<HTMLElement>(`.card[data-id="${id}"]`)?.focus({ preventScroll: true });
  });
}
