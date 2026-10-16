import { useEffect, useRef } from "react";
import type { ImageDetail } from "../bindings/ImageDetail";
import type { OpenInKinshoko } from "../bindings/OpenInKinshoko";
import { onOpenRequest, takeOpenRequest } from "../ipc";
import type { BrowserCard } from "../wall/Wall";

/** 查看器要的卡片：钉图菜单“在 Kinshoko 中打开”的参考图（参考视图），按资料库详情的尺寸与分级。 */
export function referenceCard(libraryId: string, imageId: string, detail: ImageDetail): BrowserCard {
  const rating = detail.rating.effective;
  return {
    id: imageId,
    imageId,
    libraryId,
    width: detail.width,
    height: detail.height,
    thumbnail: `${libraryId}/${imageId}/256`,
    adult: rating === "questionable" || rating === "explicit",
  };
}

/**
 * 主窗口接住钉图菜单“在 Kinshoko 中打开”（#106）：应用壳先把请求留着再打开主窗口，主窗口
 * 刚建好时（错过了事件）与已经开着时（收到事件）都去取一次；只认最后一次取到的。
 */
export function useOpenInKinshoko(handle: (request: OpenInKinshoko) => void) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const accept = () => {
      const request = ++sequence;
      void takeOpenRequest().then((value) => {
        if (alive && request === sequence && value) latest.current(value);
      }, () => {});
    };
    const stop = onOpenRequest(accept).then((fn) => { if (alive) accept(); return fn; });
    return () => { alive = false; void stop.then((fn) => fn()); };
  }, []);
}
