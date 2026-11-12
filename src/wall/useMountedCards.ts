// 图片墙要挂载哪些格子：挂载范围里的，加上动画中与最后查看的（从 Wall.tsx 原样搬出，pre-commit 的文件大小上限）。
import { useMemo } from "react";
import type { MutableRefObject } from "react";
import { visible, type masonry } from "./layout";
import type { MountWindow } from "./prefetch";
import type { TrayMotion } from "./useTrayMotion";

export function useMountedCards({ layout, mount, position, viewerOpen, selected, lastOpened, beforeReflow, motions, trayMotion }: {
  layout: ReturnType<typeof masonry>;
  mount: MountWindow;
  position: Map<string, number>;
  viewerOpen: boolean;
  selected: ReadonlySet<string>;
  lastOpened: MutableRefObject<string | null>;
  beforeReflow: MutableRefObject<Map<string, DOMRect>>;
  motions: MutableRefObject<Map<string, Animation>>;
  trayMotion: MutableRefObject<TrayMotion | null>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies(viewerOpen): 开关查看器时 lastOpened 变了，要重算
  // biome-ignore lint/correctness/useExhaustiveDependencies(selected): 选中变了时 lastOpened 可能跟着变，要重算
  return useMemo(() => {
    const found = new Set(visible(layout, mount.top, mount.bottom));
    // 查看器里调整窗口宽度后，最后查看的卡片仍能接回焦点（最多多保留一张）。
    for (const id of [lastOpened.current, ...beforeReflow.current.keys(), ...motions.current.keys()]) {
      const i = id === null || trayMotion.current?.flights.has(id) ? undefined : position.get(id); // 托盘里飞的页不强行挂载（#418）
      if (i !== undefined) found.add(i);
    }
    return [...found].sort((a, b) => a - b);
  }, [layout, mount, position, viewerOpen, selected, lastOpened, beforeReflow, motions, trayMotion]);
}
