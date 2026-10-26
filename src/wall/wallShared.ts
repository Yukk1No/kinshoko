// 图片墙各部分共用的常量、类型与位置记忆（从 Wall.tsx 原样搬出）。
import type { ReactNode } from "react";
import type { WallMenuTarget } from "./WallMenu";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { ConditionTree } from "../bindings/ConditionTree";
import type { ImageCard } from "../bindings/ImageCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import type { Anchor, Box } from "./layout";

// 常量沿用 #13 样稿（Wall.tsx）。
export const GAP = 8;
export const PAD = 12;
export const OVERSCAN = 700;
/** 目标列宽（CSS 像素），样稿的默认密度。 */
export const TARGET = 240;
/** 特别长的图整体缩小到列宽的 2.6 倍高，不裁切。 */
export const CAP_RATIO = 2.6;
export const PAGE = 500;
/** 滚动方向前方预取缩略图的距离（挂载范围之外，画布像素）与张数上限。 */
export const PREFETCH_PX = 1600;
export const PREFETCH_MAX = 48;
/** 滚动停手多久后把位置写进本地存储。 */
export const SAVE_ANCHOR_MS = 250;
/**
 * 关闭安全模式后等资料库送回成人图的最长时间（毫秒）。超过了就不再从封印书飞出，
 * 回来的图照常淡出遮蔽：动画只跟着这一次切换，不挂在之后无关的重新浏览上。
 */
export const RELEASE_WAIT = 1500;
/** 某一刻的布局：每张卡片在画布里的位置，和当时的滚动位置。 */
export type LayoutSnapshot = { boxes: Map<string, Box>; scrollTop: number };

/** 图片墙上拖出参考图时放进 dataTransfer 的类型，值为 JSON 数组的参考图 id。 */
export const DRAG_IMAGES = "application/x-kinshoko-images";
/**
 * 同一次拖动里每张图按图库列出的来源：JSON 对象 `{ 图库 id: 参考图 id[] }`。任何一个图库的文件夹都能
 * 接住拖来的图（ADR-0008），放进哪个库就取这张图在那个库里的来源。
 */
export const DRAG_IMAGE_SOURCES = "application/x-kinshoko-image-sources";

export type WallHandle = {
  previewDensity: (value: number | null) => void;
  /** 已知工作区变了：立刻作废在途响应，不等下一次 React 渲染。 */
  invalidate: () => void;
  /** 读下一页（查看器走过已读到的卡片时）；已在读或没有下一页时什么也不做。 */
  loadMore: () => void;
  /** 选中已读到的全部图（Ctrl+A，空白处菜单的“全选”）。 */
  selectAll: () => void;
  /**
   * 先把这些卡片从墙上移走，其余卡片照常滑过去补位，不等后端（#290）。
   * 返回放回函数：后端没做成的那部分按 id 放回原位；已放回或已不在的不重复放。
   */
  remove: (ids: string[]) => (failedIds: string[]) => void;
};

/** 卡片上的快捷键（与右键菜单同一选择规则）：P 钉住、F1 进入查看器框选、Del 移到回收站、Ctrl+C 复制图片。 */
export type CardCommand = "pin" | "crop" | "trash" | "copy";

export type BrowserCard = ImageCard & Partial<Pick<WorkspaceCard, "libraryId" | "imageId" | "sources">>;

export type WallProps = {
  workspaceScope?: WorkspaceScope;
  onInspectSources?: (card: WorkspaceCard) => void;
  onCardsChange?: (cards: BrowserCard[]) => void;
  /** 只有当前请求已完整接受的工作区快照，才能成为父界面的已知状态。 */
  onWorkspaceStatus?: (status: WorkspaceStatus, cards: BrowserCard[]) => void;
  /** Artist-selected target card width; preview stays local until the slider commits. */
  density?: number;
  /** Ctrl+滚轮缩放中的本地预览（#111），让图片大小滑条跟着走；null 为撤掉预览。 */
  onDensityPreview?: (value: number | null) => void;
  /** Ctrl+滚轮最后一格后 220 ms 提交的图片大小，与滑条提交同一个值。 */
  onDensityCommit?: (value: number) => void;
  onTotalChange?: (count: number | null) => void;
  libraryId: string;
  scope: BrowseScope;
  /** Search 给出的条件树；没有条件时是范围内的全部。条件变化时由调用方换 key 重建，从顶部看起。 */
  conditions?: ConditionTree;
  /** 资料库报告列表过期时递增：重新浏览，保持正在看的位置。 */
  reloadKey: number;
  /**
   * 安全模式（#60）。开启的一刻，还在墙上的含成人内容的图立即遮蔽（模糊并覆上墨色），
   * 等重新浏览后离开；关闭后回来的图先遮着，下一帧淡出遮蔽。
   */
  safeMode?: boolean;
  /**
   * 容器宽度还没稳定（详情面板开合的过渡中、拖动面板边缘时，#162/#157）：保持现在的布局，
   * 多出的部分被裁掉；变回 false 时按稳定后的宽度只重排一次。单击卡片后的双击间隔里同样不重排（#179），
   * 两者都结束时才重排。
   */
  holdReflow?: boolean;
  selected: ReadonlySet<string>;
  onSelectionChange: (selected: Set<string>) => void;
  onOpenImage: (card: BrowserCard) => void;
  /** 查看器盖在图片墙上（#179）；关闭时选中的那张（最后查看的图）滚入可见并获得焦点。 */
  viewerOpen: boolean;
  /** 右键菜单的内容（#102）；不给出时图片墙没有右键菜单。 */
  menu?: (target: WallMenuTarget) => ReactNode;
  onCardCommand?: (command: CardCommand, cards: BrowserCard[], point: { x: number; y: number }) => void;
  /** Ctrl+V：从剪贴板导入（#105）。主窗口里焦点不在输入框、没有模态与查看器时都响应。 */
  onPaste?: () => void;
};

/** 按键落在可输入的地方（输入框、文本框、可编辑区域）：Ctrl+V 是粘贴文字，不是导入。 */
export const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null);

/** 每个范围各自记住位置。“全部”沿用 #44 的键。 */
export const scopeKey = (scope: BrowseScope) =>
  (scope.kind === "folder" || scope.kind === "folderTree") ? `${scope.kind}.${scope.id}` : scope.kind;

export const anchorKey = (libraryId: string, scope: BrowseScope) =>
  scope.kind === "all"
    ? `kinshoko.wall.anchor.${libraryId}`
    : `kinshoko.wall.anchor.${libraryId}.${scopeKey(scope)}`;

export const EMPTY: Record<BrowseScope["kind"], string> = {
  all: "图库里还没有参考图。点右上角的“导入”，或直接拖进窗口。",
  folder: "这个文件夹里还没有参考图。选中图片后点“移到”，或把图片拖到侧栏的文件夹上。",
  folderTree: "这个文件夹及其子文件夹还没有参考图。",
  unassigned: "这个图库没有未归类的参考图。",
  trash: "回收站是空的。",
};

export const NO_CONDITIONS: ConditionTree = { conditions: [] };

export function loadAnchor(key: string): Anchor | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Anchor) : null;
  } catch {
    return null;
  }
}

export function saveAnchor(key: string, anchor: Anchor | null) {
  try {
    if (anchor) localStorage.setItem(key, JSON.stringify(anchor));
  } catch {
    // 本地存储不可用时只是不记住位置。
  }
}
