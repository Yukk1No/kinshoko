import { useEffect, useState } from "react";
import type { ImageCard } from "../bindings/ImageCard";
import { displayScaledUrl, displayUrl } from "../ipc";

/**
 * 查看器显示哪张位图：缩放停手后才换的精确来源、换来源期间的替身，以及读取失败（#128）。
 */
export function useViewerSource({ libraryId, card, mode, physicalWidth }: {
  libraryId: string; card: Omit<ImageCard, "thumbnail"> & Partial<Pick<ImageCard, "thumbnail">>; mode: "fit" | "pixels" | "zoom"; physicalWidth: number;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  /**
   * 最近读完的一张缩小派生图（fit-N）：缩到 100% 以下时临时顶上的首选，比原图便宜得多。
   * `loaded`：常驻的那个元素已读完；读完前它画不出来，不能指望它顶上。
   */
  const [derived, setDerived] = useState<{ src: string; loaded: boolean } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  /** 缩放中最近一次请求的来源宽度；记着是哪张图的，换图后不拿上一张的宽度去请求。 */
  const cardKey = `${libraryId}/${card.id}`;
  const [requested, setRequested] = useState({ key: cardKey, px: card.width });
  const desiredPx = Math.min(physicalWidth, card.width);
  const requestedPx = requested.key === cardKey ? requested.px : desiredPx;
  const setRequestedPx = (px: number) => setRequested({ key: cardKey, px });
  const sourcePx = mode === "zoom" ? requestedPx : desiredPx;
  const exactSource = sourcePx === desiredPx;
  // 1:1 与放大走 Library::display（原图或原尺寸 sdr 派生图）；缩小走精确尺寸派生图。从不直接读原文件。
  const originalUrl = displayUrl(libraryId, card.id);
  const isOriginal = (address: string) => address.startsWith(originalUrl);
  const address = sourcePx >= card.width ? originalUrl : displayScaledUrl(libraryId, card.id, sourcePx);
  const src = address + (retry ? `?retry=${retry}` : "");
  // WebView2 不取消被换掉的请求，每张派生图都要整图解码；同一时刻只等一张，否则快速缩放时积压，迟迟出不了图。
  const sourcePending = loadedSrc !== src && failedSrc !== src;
  // 连续缩放时只在停手 120 ms 后换来源（#128），原图也一样：大图第一次上屏要整张解码上传，放在手势中间会卡一帧。
  // 每一格缩放都重新计时（100% 以上 desiredPx 不变，要看 physicalWidth）。期间已读完的位图按当前尺寸临时缩放显示，
  // 画面跟手；精确来源读完才换上，静止时看到的仍只来自 ADR-0005 的两条路。
  useEffect(() => {
    if (mode !== "zoom") { setRequestedPx(desiredPx); return; }
    if (requestedPx === desiredPx || sourcePending) return;
    const timer = window.setTimeout(() => setRequestedPx(desiredPx), 120);
    return () => window.clearTimeout(timer);
  }, [desiredPx, physicalWidth, mode, requestedPx, sourcePending, cardKey]);
  const ready = loadedSrc === src;
  const failed = exactSource && failedSrc === src;
  /**
   * 替身（#128）：精确来源还没就绪时临时顶上的位图，按当前位置与尺寸显示。缩到 100% 以下优先用最近的缩小派生图——
   * 让 Chromium 每帧把整张大原图重采样到新尺寸，一帧要 50～140 ms（8000 px 实测）。派生图替身的元素一直挂着（隐藏），
   * 要用时已经读完；读完之前由最近读完的位图当替身。精确来源读取失败时不留替身，只显示错误。
   */
  const derivedMounted = derived !== null && derived.src !== src;
  const derivedStandIn = derivedMounted && derived.loaded && !failed && !(ready && exactSource)
    && (desiredPx < card.width || (!ready && loadedSrc === derived.src));
  const lastStandIn = !ready && !derivedStandIn && !failed ? loadedSrc : null;
  /** 解码完再换上，换图那一帧不空白；换走或换了图的元素不再回写。 */
  const swapIn = (image: HTMLImageElement, loaded: string) => {
    const done = () => {
      if (!image.isConnected) return;
      setLoadedSrc(loaded);
      if (!isOriginal(loaded)) setDerived({ src: loaded, loaded: false });
    };
    if (typeof image.decode === "function") image.decode().then(done, done); else done();
  };
  return { loadedSrc, setLoadedSrc, derived, setDerived, failedSrc, setFailedSrc, setRetry, src, exactSource, isOriginal, ready, failed, derivedMounted, derivedStandIn, lastStandIn, swapIn };
}
