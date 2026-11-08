// 截图时登记图片墙上看得见的参考图。
import type { MutableRefObject } from "react";
import { captureImage, useCaptureSources } from "../desktop/captureSources";
import { modalOpen } from "../ui/modal";
import type { BrowserCard } from "./wallShared";

export function useWallCaptureSources({ viewerOpen, scroller, cards }: {
  viewerOpen: boolean;
  scroller: MutableRefObject<HTMLDivElement | null>;
  cards: BrowserCard[];
}) {
  useCaptureSources(() => {
    // 模态盖住图片墙时不登记来源；行内浮层（role="dialog" 的查找浮层等）不挡。
    if (viewerOpen || !scroller.current || modalOpen()) return null;
    // 一摞只登记封面（#418）：下面的纸转过、裁过，也不是封面那张原图，框到纸边时按普通截图处理。
    return [...scroller.current.querySelectorAll<HTMLImageElement>(".card > img, .card > .stack-cover > img")].flatMap((image) => {
      const node = image.closest<HTMLElement>(".card")!;
      const card = cards.find((item) => item.id === node.dataset.id);
      if (!card?.libraryId || node.dataset.veiled === "true") return [];
      const reference = captureImage(image, scroller.current!, card.libraryId, card.imageId ?? card.id, card.width, card.height);
      return reference ? [reference] : [];
    });
  }, 10);
}
