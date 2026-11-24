import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction, useMemo } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceCard as SourcesCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { useInspectorWidth } from "../shell/InspectorResizer";
import type { BrowserCard } from "../wall/Wall";
import { pagesOf, stackHolding, viewedPage } from "../wall/imageSets";

/** 详情面板（#98）：整理哪些图、是否打开、宽度与开合过渡。 */
export function useWorkspaceInspector({
  selected,
  setSelected,
  loadedCards,
  workspaceScope,
  sources,
  setSources,
  hidden,
  viewing,
  inspectorWidth,
  fitPanel,
  inspectorShown,
  onInspectorShown,
}: {
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  loadedCards: BrowserCard[];
  workspaceScope: WorkspaceScope;
  sources: WorkspaceCard | null;
  setSources: Dispatch<SetStateAction<WorkspaceCard | null>>;
  hidden: boolean;
  viewing: BrowserCard | null;
  inspectorWidth?: number;
  /** 窄窗口里详情面板实际画多宽（paneFit）；保存的宽度不变。 */
  fitPanel?: (width: number) => number;
  /** 详情面板是否打开：只由画师亲手开合，选择图片不改变它，所以点图时图片墙不会重排。 */
  inspectorShown: boolean;
  onInspectorShown: (open: boolean) => void;
}) {
  // 详情面板（#98）：明确打开的多来源整理优先；否则显示当前选择的整理。开合与选择无关。
  const selectionKey = [...selected].sort().join("\n");
  // 详情面板整理哪个图库（ADR-0008，#113）：范围是某个图库时就是它；“全部图片”下选中的图都只有同一个图库的
  // 来源时是那个库。单选、多选都可以整理任何一个图库（#422）；单选一张有几份来源的图、定不下图库时，走下面的来源整理；
  // 多选定不下图库时面板内容留空，宽度不变，选择的反馈在多选悬浮栏。
  // 一摞收着的各页（#418）也算已读：查看器走到它们时，详情面板整理的是正在看的这一页。
  const allCards = useMemo(
    () => loadedCards.flatMap((card) => (card.set ? [card, ...(card.set.pages.slice(1) as BrowserCard[])] : [card])),
    [loadedCards],
  );
  // 墙上选中整摞时（#418）整理它的全部页：加标签、移文件夹、删除都作用于每一页，多选悬浮栏报的是张数。
  // 查看器开着时只整理正在看的这一页，即使它是封面。
  const chosen = allCards.filter((card) => selected.has(card.id));
  const readCards = viewing ? chosen.map(viewedPage) : pagesOf(chosen);
  // 列表重读期间选中的图暂时不在已读卡片里：沿用这组选择上次读到的卡片，面板不变空，等修剪选择后再定。
  const lastSelection = useRef<{ key: string; cards: BrowserCard[] } | null>(null);
  if (readCards.length) lastSelection.current = { key: selectionKey, cards: readCards };
  const selectedCards = readCards.length
    ? readCards
    : lastSelection.current?.key === selectionKey
      ? lastSelection.current.cards
      : [];
  const soleLibrary = selectedCards[0]?.sources?.length === 1 ? selectedCards[0].sources[0].libraryId : null;
  const selectionLibrary =
    workspaceScope.kind === "library"
      ? workspaceScope.libraryId
      : soleLibrary &&
          selectedCards.every((card) => card.sources?.length === 1 && card.sources[0].libraryId === soleLibrary)
        ? soleLibrary
        : null;
  const eligible = selected.size > 0 && selectionLibrary !== null;
  // 选中一张在几个图库各有一份的图时，详情面板显示它的来源整理（卡片上的来源按钮同样可打开）。
  const selectedSourceCard =
    !eligible && selected.size === 1
      ? (selectedCards.find((card) => card.sources?.length && card.libraryId && card.imageId) as
          | SourcesCard
          | undefined)
      : undefined;
  // 钉图菜单打开的那一份不是图片墙上代表这张图的那一份：详情跟着查看器正在看的这一份。
  const viewedCopy =
    viewing &&
    selected.size === 1 &&
    selectedCards[0]?.id === viewing.id &&
    viewing.libraryId !== selectedCards[0].libraryId
      ? (viewing as WorkspaceCard)
      : undefined;
  const inspected = sources ?? viewedCopy ?? selectedSourceCard ?? null;
  const inspectorContent = inspected !== null || eligible;
  // 详情面板整理的那个图库里的选中图。
  const panelIds = selectedCards.flatMap(
    (card) =>
      card.sources
        ?.filter((source) => source.libraryId === selectionLibrary && !source.unavailable)
        .map((source) => source.imageId) ?? [],
  );
  /** 来源整理是查看器为墙外那张图打开的（不是画师点来源按钮打开的）。 */
  const viewedSources = useRef(false);
  const viewingOutside = viewedSources.current && sources !== null;
  const inspectorOpen = inspectorShown && !hidden;
  /**
   * 查看器里的详情侧栏跟着正在看的图（#179）：打开或换图时选择改为这一张。不在图片墙上的图
   * （钉图菜单“在 Kinshoko 中打开”）走来源整理。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在打开查看器或换图时同步选择；墙上的卡片只在那一刻读
  useEffect(() => {
    if (!viewing) {
      // 离开查看器：为墙外那张图打开的来源整理随之收起。
      if (viewedSources.current) {
        viewedSources.current = false;
        setSources(null);
      }
      // 最后看的是收在一摞里的页（#418）：墙上看不见它，选择回到这一摞。
      setSelected((previous) => {
        const stack = previous.size === 1 ? stackHolding(loadedCards, previous.values().next().value!) : null;
        return stack ? new Set([stack]) : previous;
      });
      return;
    }
    viewedSources.current = false;
    if (!allCards.some((card) => card.id === viewing.id)) {
      if (viewing.libraryId && viewing.imageId && viewing.sources?.length) {
        viewedSources.current = true;
        setSources(viewing as WorkspaceCard);
      }
      return;
    }
    setSources(null);
    setSelected((previous) => (previous.size === 1 && previous.has(viewing.id) ? previous : new Set([viewing.id])));
  }, [viewing]);
  const [inspectorElement, setInspectorElement] = useState<HTMLElement | null>(null);
  // 拖动边缘时图片墙不逐帧重排，松手后重排一次（#157）。
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  const panelWidth = useInspectorWidth(draggedWidth ?? inspectorWidth);
  const shownWidth = fitPanel ? fitPanel(panelWidth) : panelWidth;
  // 面板与右下角的任务卡片（挂在 body 上）共用这个宽度。
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${shownWidth}px`);
  }, [shownWidth]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--inspector-width");
    },
    [],
  );
  /** 收起面板。墙外那张图的来源整理留着：再打开时还是它，不露出图片墙上的选择。 */
  const closeInspector = () => {
    if (!viewingOutside) setSources(null);
    onInspectorShown(false);
  };
  /** 卡片的来源按钮与右键“查看来源”：明确要看，面板随之打开并留着。 */
  const openSources = (card: WorkspaceCard) => {
    setSources(card);
    onInspectorShown(true);
  };
  /** 来源整理自己要关闭（Esc、安全模式下改成成人分级）：明确打开的让位，选择打开的取消选择。 */
  const closeSources = () => {
    if (viewingOutside) onInspectorShown(false);
    else if (sources) setSources(null);
    else setSelected(new Set());
  };
  /** 顶栏按钮、I 键、查看器 dock 与右键菜单：显示或隐藏详情面板。 */
  const toggleInspector = () => {
    if (inspectorOpen) closeInspector();
    else onInspectorShown(true);
  };

  return {
    selectionKey,
    selectionLibrary,
    selectedCards,
    eligible,
    inspected,
    inspectorContent,
    panelIds,
    inspectorOpen,
    inspectorElement,
    setInspectorElement,
    shownWidth,
    draggedWidth,
    setDraggedWidth,
    panelWidth,
    closeInspector,
    openSources,
    closeSources,
    toggleInspector,
  };
}

export type WorkspaceInspectorState = ReturnType<typeof useWorkspaceInspector>;
