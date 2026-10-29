// 图片墙上的一张卡片：缩略图、占位图与来源按钮（从 Wall.tsx 原样搬出）。
import { Fragment } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import { Layers } from "lucide-react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { thumbnailUrl } from "../ipc";
import type { Box } from "./layout";
import { cardThumbnail } from "./thumbnailTier";
import type { BrowserCard } from "./wallShared";
import { markThumbnailShown } from "../startupTiming";

/**
 * 缩略图到达的标记直接写在节点上，不经 React 渲染（滚动时不为每张图重渲染）。
 * 重新挂载时已在浏览器缓存里的图直接显示，不再淡入；其余到达后淡入、盖住占位图。
 */
export const markCachedThumbnail = (img: HTMLImageElement | null) => {
  if (!img) return;
  if (img.complete && img.naturalWidth > 0) img.dataset.loaded = "instant";
  // 卡片离开挂载范围时缩略图还没到：撤掉地址，浏览器放弃这次请求，不再替已经看不见的卡片取图（#123）。
  return () => {
    if (!img.complete) img.removeAttribute("src");
  };
};
export const markThumbnailLoaded = (e: { currentTarget: HTMLImageElement }) => {
  if (!e.currentTarget.dataset.loaded) e.currentTarget.dataset.loaded = "fade";
  markThumbnailShown();
};


/** 来源按钮的图标：同一个元素，卡片重排重新渲染时 React 直接跳过它。 */
const SOURCES_ICON = <Layers size={11} aria-hidden="true" />;

/** 卡片的事件处理；沿用的卡片元素读 ref 里的最新版本。 */
export type CardHandlers = {
  click: (card: BrowserCard, e: MouseEvent) => void;
  open: (card: BrowserCard) => void;
  cardKey: (card: BrowserCard, e: KeyboardEvent<HTMLElement>) => void;
  dragStart: (id: string, e: DragEvent) => void;
  inspect?: (card: WorkspaceCard) => void;
};

export function wallCardNode({ card, thumbnailPx, b, landing, veiled, leaving, selected, workspaceScope, cardHandlers, lastOpened }: {
  card: BrowserCard;
  thumbnailPx: number;
  b: Box;
  landing: boolean;
  veiled: boolean;
  leaving: boolean;
  selected: ReadonlySet<string>;
  workspaceScope: WorkspaceScope | undefined;
  cardHandlers: MutableRefObject<CardHandlers>;
  lastOpened: MutableRefObject<string | null>;
}): ReactNode {
  const sources = card.libraryId && card.imageId ? card.sources ?? [] : [];
  return (
    <Fragment key={card.id}>
    <div
      className={landing ? "card is-arriving" : "card"}
      data-id={card.id}
      aria-selected={selected.has(card.id)}
      role="option"
      tabIndex={0}
      data-veiled={veiled}
      data-leaving={leaving}
      draggable={!workspaceScope || workspaceScope.kind === "library" || (card.sources?.some((source) => !source.unavailable) ?? false)}
      onClick={(e) => cardHandlers.current.click(card, e)}
      onKeyDown={(e) => cardHandlers.current.cardKey(card, e)}
      onDragStart={(e) => cardHandlers.current.dragStart(card.id, e)}
      style={{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }}
    >
      <img src={thumbnailUrl(cardThumbnail(card, thumbnailPx))} alt="参考图" decoding="async" draggable={false}
        ref={markCachedThumbnail} onLoad={markThumbnailLoaded} />
      {/* 占位图（#110）：缩略图到达前放大模糊显示；遮蔽中的图不露出它的色彩。 */}
      {card.placeholder && !veiled && <div className="card-placeholder" aria-hidden="true"
        style={{ backgroundImage: `url("${card.placeholder}")` }} />}
    </div>
    {/* 来源按钮是卡片选项的兄弟，不在选项里：选项内不放可聚焦的子元素。只在一个图库的图不放按钮（#221），所在图库在详情里看。 */}
    {sources.length >= 2 && <button type="button" className="card-sources" data-card={card.id}
      aria-label={`在 ${sources.length} 个图库，查看详情`}
      title={`在 ${sources.length} 个图库`}
      style={{ left: `${b.x + b.w - 8}px`, top: `${b.y + b.h - 8}px` }}
      onClick={(e) => { e.stopPropagation(); lastOpened.current = card.id; cardHandlers.current.inspect?.(card as WorkspaceCard); }}
      onKeyDown={(e) => e.stopPropagation()}>{SOURCES_ICON}<span className="k-label">{`${sources.length} 处`}</span></button>}
    </Fragment>
  );
}
