
import type { ReceivedImage } from "../bindings/ReceivedImage";
import { thumbnailUrl } from "../ipc";
import { imageKey, } from "./useSubscriptionData";

/** 图片墙的缩略图档位（`thumbnailTier` 的一档），五列左右时够清楚。 */
const TILE_PX = 384;

// 订阅页的缩略图格子，原样从 SubscriptionsPage.tsx 移出。

export function Tiles({ images, label, onOpen, onFail }: {
  images: ReceivedImage[]; label: string; onOpen: (libraryId: string, imageId: string) => void; onFail: (key: string) => void;
}) {
  return <ul className="subs-tiles">
    {images.map((image) => <li key={imageKey(image)}>
      <button type="button" className="subs-tile" data-library-id={image.libraryId} data-image-id={image.imageId} aria-label={label} onClick={() => onOpen(image.libraryId, image.imageId)}>
        <img src={thumbnailUrl(`${image.libraryId}/${image.imageId}/${TILE_PX}`)} alt="" decoding="async" draggable={false}
          onError={() => onFail(imageKey(image))} />
      </button>
    </li>)}
  </ul>;
}
