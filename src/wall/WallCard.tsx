// 图片墙上的一张卡片：缩略图、占位图与来源按钮。
import { Fragment } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent, MutableRefObject, ReactNode } from "react";
import { Check, Layers, SquareStack } from "lucide-react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { thumbnailUrl } from "../ipc";
import { i18n } from "../i18n";
import type { Box } from "./layout";
import { stackPaper } from "./stackPaper";
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
/** 一摞的张数按钮（#418）：与来源按钮的 Layers 分开。 */
const STACK_ICON = <SquareStack size={11} aria-hidden="true" />;
const CHECK_ICON = <Check size={11} aria-hidden="true" />;

/** 卡片的事件处理；沿用的卡片元素读 ref 里的最新版本。 */
export type CardHandlers = {
  click: (card: BrowserCard, e: MouseEvent) => void;
  open: (card: BrowserCard) => void;
  cardKey: (card: BrowserCard, e: KeyboardEvent<HTMLElement>) => void;
  dragStart: (id: string, e: DragEvent) => void;
  inspect?: (card: WorkspaceCard) => void;
  /** 点一摞的张数：打开或关上它的托盘（#418）。 */
  toggleTray: (card: BrowserCard) => void;
  /** 点托盘里页角的勾：增减这一页的选择，与 Ctrl 单击相同。 */
  check: (card: BrowserCard, e: MouseEvent) => void;
};

/** 缩略图与它的占位图（#110）：缩略图到达前放大模糊显示；遮蔽中的图不露出它的色彩。 */
function picture(card: BrowserCard, thumbnailPx: number, veiled: boolean) {
  return <>
    <img src={thumbnailUrl(cardThumbnail(card, thumbnailPx))} alt={i18n.t("wall:card.alt")} decoding="async" draggable={false}
      ref={markCachedThumbnail} onLoad={markThumbnailLoaded} />
    {card.placeholder && !veiled && <div className="card-placeholder" aria-hidden="true"
      style={{ backgroundImage: `url("${card.placeholder}")` }} />}
  </>;
}

/**
 * 一摞（#418）：封面摆正、四周留出纸边，下面露出后面几页（每层是那一页的缩略图），底下一块接触阴影，页数越多越重。
 * 摆法按图集键固定（见 stackPaper）。
 */
function stackFace(card: BrowserCard, b: Box, inset: number, thumbnailPx: number, veiled: boolean) {
  const pages = card.set!.pages;
  const face = { w: b.w - inset * 2, h: b.h - inset * 2 };
  const sheets = stackPaper(card.set!.key, pages.map((page) => ({ w: page.width, h: page.height })), face);
  const pose = ({ x, y, r }: { x: number; y: number; r: number }) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r.toFixed(2)}deg)`;
  return <>
    <div className="stack-contact" aria-hidden="true"
      style={{ left: `${inset + 8}px`, width: `${face.w - 16}px`, top: `${inset + face.h - 9}px`, opacity: 0.4 + sheets.length * 0.15 }} />
    {sheets.map((sheet) => {
      const page = pages[sheet.page];
      return <div key={page.id} className="stack-sheet" aria-hidden="true"
        style={{ left: `${inset}px`, top: `${inset}px`, width: `${sheet.w}px`, height: `${sheet.h}px`,
          ["--rest" as string]: pose(sheet.rest), ["--hot" as string]: pose(sheet.hot) }}>
        {picture(page, thumbnailPx, veiled || page.adult)}
      </div>;
    })}
    <div className="stack-cover" style={{ left: `${inset}px`, top: `${inset}px`, width: `${face.w}px`, height: `${face.h}px` }}>
      {picture(card, thumbnailPx, veiled)}
    </div>
  </>;
}

export function wallCardNode({ card, thumbnailPx, b, landing, veiled, leaving, selected, workspaceScope, cardHandlers, lastOpened, trayPage = 0, trayCount = 0, inset = 0 }: {
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
  /** 托盘里的第几页（从 1 起，#418）；不在托盘里为 0。 */
  trayPage?: number;
  /** 打开的托盘里的页数。 */
  trayCount?: number;
  /** 一摞封面四周的纸边（CSS 像素）。 */
  inset?: number;
}): ReactNode {
  const sources = card.libraryId && card.imageId ? card.sources ?? [] : [];
  const stack = card.set && trayPage === 0 ? card.set : null;
  // 张数按钮在封面左上角；托盘打开时留在第 1 页上，再点一次叠回去。
  const count = stack ? stack.pages.length : trayPage === 1 ? trayCount : 0;
  const corner = stack ? inset : 0;
  return (
    <Fragment key={card.id}>
    <div
      className={`card${stack ? " is-stack" : ""}${trayPage ? " is-tray-page" : ""}${landing ? " is-arriving" : ""}`}
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
      {stack ? stackFace(card, b, inset, thumbnailPx, veiled) : picture(card, thumbnailPx, veiled)}
    </div>
    {/* 托盘里页角的勾（#418）：增减这一页的选择。紧跟在卡片后面（悬停卡片时露出）；第 1 页的左上角是张数，勾放在右上角。 */}
    {trayPage > 0 && <button type="button" role="checkbox" className="card-check" data-card={card.id}
      aria-checked={selected.has(card.id)} aria-label={i18n.t("wall:card.pageLabel", { page: trayPage })}
      style={{ left: `${b.x + b.w - 28}px`, top: `${b.y + 6}px` }}
      onClick={(e) => { e.stopPropagation(); cardHandlers.current.check(card, e); }}
      onKeyDown={(e) => e.stopPropagation()}>{CHECK_ICON}</button>}
    {count >= 2 && <button type="button" className="card-count" data-card={card.id}
      aria-label={i18n.t("wall:card.stackLabel", { count })} aria-expanded={trayPage === 1}
      style={{ left: `${b.x + corner + 6}px`, top: `${b.y + corner + 6}px` }}
      onClick={(e) => { e.stopPropagation(); cardHandlers.current.toggleTray(card); }}
      onKeyDown={(e) => e.stopPropagation()}>{STACK_ICON}<span className="k-label">{count}</span></button>}
    {/* 来源按钮是卡片选项的兄弟，不在选项里：选项内不放可聚焦的子元素。只在一个图库的图不放按钮（#221），所在图库在详情里看。 */}
    {sources.length >= 2 && <button type="button" className="card-sources" data-card={card.id}
      aria-label={i18n.t("wall:card.sourcesLabel", { count: sources.length })}
      title={i18n.t("wall:card.sourcesTitle", { count: sources.length })}
      style={{ left: `${b.x + b.w - corner - 8}px`, top: `${b.y + b.h - corner - 8}px` }}
      onClick={(e) => { e.stopPropagation(); lastOpened.current = card.id; cardHandlers.current.inspect?.(card as WorkspaceCard); }}
      onKeyDown={(e) => e.stopPropagation()}>{SOURCES_ICON}<span className="k-label">{i18n.t("wall:card.sourcesCount", { count: sources.length })}</span></button>}
    </Fragment>
  );
}
