import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { captureAnchor, masonry, type Anchor } from "./layout";
import { SAVE_ANCHOR_MS, SCROLLING_MS, saveAnchor, type BrowserCard } from "./wallShared";
import { storableAnchor, useOpenTray } from "./imageSets";

// 图片墙的滚动处理（挂载范围、方向、位置的记录），原样从 Wall.tsx 移出。

type Args = {
  scroller: RefObject<HTMLDivElement | null>;
  syncMount: (el: HTMLElement) => void;
  scrollDirection: MutableRefObject<1 | -1>;
  lastScrollTop: MutableRefObject<number>;
  settledTop: MutableRefObject<number | null>;
  restoring: MutableRefObject<boolean>;
  anchor: MutableRefObject<Anchor | null>;
  anchorToStore: MutableRefObject<() => Anchor | null>;
  shown: BrowserCard[];
  tray: ReturnType<typeof useOpenTray>["tray"];
  trayIds: ReadonlySet<string>;
  layout: ReturnType<typeof masonry>;
  ids: string[];
  storeKey: string | null;
};

export function useWallScroll({
  scroller,
  syncMount,
  scrollDirection,
  lastScrollTop,
  settledTop,
  restoring,
  anchor,
  anchorToStore,
  shown,
  tray,
  trayIds,
  layout,
  ids,
  storeKey,
}: Args) {
  const scrollingTimer = useRef(0);
  useEffect(() => () => clearTimeout(scrollingTimer.current), []);
  /** 停手后才写本地存储（#109：不在每个滚动事件里同步写）；卸载与页面隐藏时立即写。 */
  const pendingSave = useRef<{ key: string; timer: number } | null>(null);
  anchorToStore.current = () => storableAnchor(anchor.current, shown, tray, trayIds);
  const flushSave = useCallback(() => {
    const pending = pendingSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSave.current = null;
    saveAnchor(pending.key, anchorToStore.current());
  }, [anchorToStore]);
  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => {
      window.removeEventListener("pagehide", flushSave);
      flushSave();
    };
  }, [flushSave]);

  const onScroll = () => {
    const el = scroller.current!;
    syncMount(el);
    // 滚动中不拿起一摞（#418）。
    el.dataset.scrolling = "";
    clearTimeout(scrollingTimer.current);
    scrollingTimer.current = window.setTimeout(() => {
      delete el.dataset.scrolling;
    }, SCROLLING_MS);
    if (el.scrollTop !== lastScrollTop.current) scrollDirection.current = el.scrollTop > lastScrollTop.current ? 1 : -1;
    lastScrollTop.current = el.scrollTop;
    // 自己为锚点做的滚动不重新取锚，否则每次重排都会漂到另一张图。
    const own = settledTop.current !== null && Math.abs(el.scrollTop - settledTop.current) < 1;
    if (own || restoring.current) return;
    settledTop.current = null;
    anchor.current = captureAnchor(layout, ids, el.scrollTop, el.clientHeight);
    if (storeKey) {
      if (pendingSave.current) clearTimeout(pendingSave.current.timer);
      pendingSave.current = { key: storeKey, timer: window.setTimeout(flushSave, SAVE_ANCHOR_MS) };
    }
  };
  return { onScroll };
}
