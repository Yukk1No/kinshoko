// 截图时登记图片墙上看得见的参考图。
import type { MutableRefObject } from "react";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { modalOpen } from "../ui/modal";
import type { BrowserCard } from "./wallShared";

export function useWallCaptureSources({ viewerOpen, scroller, cards, libraryId }: {
  viewerOpen: boolean;
  scroller: MutableRefObject<HTMLDivElement | null>;
  cards: BrowserCard[];
  libraryId: string;
}) {
  useCaptureSources(() => {
    // 模态盖住图片墙时不登记来源；行内浮层（role="dialog" 的查找浮层等）不挡。
    if (viewerOpen || !scroller.current || modalOpen()) return null;
    return [...scroller.current.querySelectorAll<HTMLImageElement>(".card img")].flatMap((image) => {
      const node = image.closest<HTMLElement>(".card")!;
      const card = cards.find((item) => item.id === node.dataset.id);
      if (!card || node.dataset.veiled === "true") return [];
      const reference = captureImage(image, scroller.current!, card.libraryId ?? libraryId, card.imageId ?? card.id, card.width, card.height);
      return reference ? [reference] : [];
    });
  }, 10);
}
