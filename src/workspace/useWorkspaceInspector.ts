import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceCard as SourcesCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import { useInspectorWidth } from "../shell/InspectorResizer";
import { useWidthTransition } from "../shell/useWidthTransition";
import type { BrowserCard } from "../wall/Wall";

/** 详情面板（#98）：整理哪些图、是否打开、宽度与开合过渡。 */
export function useWorkspaceInspector({
  selected, setSelected, loadedCards, workspaceScope, sources, setSources, hidden, viewing, inspectorWidth, fitPanel,
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
}) {
  // 详情面板（#98）：明确打开的多来源整理优先；否则显示当前选择的整理。
  const selectionKey = [...selected].sort().join("\n");
  const [inspectorHidden, setInspectorHidden] = useState<string | null>(null);
  // 详情面板整理哪个图库（ADR-0008，#113）：范围是某个图库时就是它；“全部图片”下选中的图都只有同一个图库的
  // 来源时是那个库。单选、多选都可以整理任何一个图库（#422）；单选一张有几份来源的图、定不下图库时，走下面的来源整理；
  // 多选定不下图库时不显示详情面板，选择的反馈在多选悬浮栏。
  const readCards = loadedCards.filter((card) => selected.has(card.id));
  // 列表重读期间选中的图暂时不在已读卡片里：沿用这组选择上次读到的卡片，面板不变空，等修剪选择后再定。
  const lastSelection = useRef<{ key: string; cards: BrowserCard[] } | null>(null);
  if (readCards.length) lastSelection.current = { key: selectionKey, cards: readCards };
  const selectedCards = readCards.length ? readCards : lastSelection.current?.key === selectionKey ? lastSelection.current.cards : [];
  const soleLibrary = selectedCards[0]?.sources?.length === 1 ? selectedCards[0].sources[0].libraryId : null;
  const selectionLibrary = workspaceScope.kind === "library" ? workspaceScope.libraryId
    : soleLibrary && selectedCards.every((card) => card.sources?.length === 1 && card.sources[0].libraryId === soleLibrary) ? soleLibrary : null;
  const eligible = selected.size > 0 && selectionLibrary !== null;
  // 选中一张在几个图库各有一份的图时，详情面板显示它的来源整理（卡片上的来源按钮同样可打开）。
  const selectedSourceCard = !eligible && selected.size === 1
    ? selectedCards.find((card) => card.sources?.length && card.libraryId && card.imageId) as SourcesCard | undefined
    : undefined;
  // 钉图菜单打开的那一份不是图片墙上代表这张图的那一份：详情跟着查看器正在看的这一份。
  const viewedCopy = viewing && selected.size === 1 && selectedCards[0]?.id === viewing.id && viewing.libraryId !== selectedCards[0].libraryId
    ? viewing as WorkspaceCard : undefined;
  const inspected = sources ?? viewedCopy ?? selectedSourceCard ?? null;
  const inspectorContent = inspected !== null || eligible;
  // 详情面板整理的那个图库里的选中图。
  const panelIds = selectedCards.flatMap((card) =>
    card.sources?.filter((source) => source.libraryId === selectionLibrary && !source.unavailable).map((source) => source.imageId) ?? []);
  /** 来源整理是查看器为墙外那张图打开的（不是画师点来源按钮打开的）。 */
  const viewedSources = useRef<string | null>(null);
  const viewingOutside = viewedSources.current !== null;
  // 面板此刻显示的对象：收起标记只对它有效。墙外那张图的来源整理跟选择无关，收起时也不能露出选择的详情。
  const panelKey = viewedSources.current ?? selectionKey;
  // 换了对象就不再记得上一个收起过：否则再选回那张图时面板不开，图片墙上也没有别的办法打开它。
  if (inspectorHidden !== null && inspectorHidden !== panelKey) setInspectorHidden(null);
  const inspectorOpen = inspectorContent && !hidden && ((sources !== null && !viewingOutside) || inspectorHidden !== panelKey);
  /**
   * 查看器里的详情侧栏跟着正在看的图（#179）：打开或换图时选择改为这一张。画师在查看器里隐藏了侧栏，
   * 换图时保持隐藏（隐藏的标记跟着换到新的对象，退出时回到选择）。不在图片墙上的图（钉图菜单“在 Kinshoko 中打开”）
   * 走来源整理。
   */
  const lastSelectionKey = useRef(selectionKey);
  const lastPanelKey = useRef(panelKey);
  lastSelectionKey.current = selectionKey;
  lastPanelKey.current = panelKey;
  useEffect(() => {
    const from = lastPanelKey.current;
    const moveHidden = (to: string) => setInspectorHidden((key) => key !== null && key === from ? to : key);
    if (!viewing) {
      // 离开查看器：为墙外那张图打开的来源整理随之收起。
      if (viewedSources.current) { viewedSources.current = null; setSources(null); moveHidden(lastSelectionKey.current); }
      return;
    }
    viewedSources.current = null;
    if (!loadedCards.some((card) => card.id === viewing.id)) {
      if (viewing.libraryId && viewing.imageId && viewing.sources?.length) {
        viewedSources.current = viewing.id;
        setSources(viewing as WorkspaceCard);
        moveHidden(viewing.id);
      }
      return;
    }
    setSources(null);
    moveHidden(viewing.id);
    setSelected((previous) => previous.size === 1 && previous.has(viewing.id) ? previous : new Set([viewing.id]));
  }, [viewing]); // eslint-disable-line react-hooks/exhaustive-deps
  // 详情面板开合的宽度过渡中图片墙不逐帧重排，过渡结束后重排一次（#162）；拖动边缘时同样，松手后重排（#157）。
  const [inspectorElement, setInspectorElement] = useState<HTMLElement | null>(null);
  const inspectorMoving = useWidthTransition(inspectorElement);
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  const panelWidth = useInspectorWidth(draggedWidth ?? inspectorWidth);
  const shownWidth = fitPanel ? fitPanel(panelWidth) : panelWidth;
  // 面板与右下角的任务卡片（挂在 body 上）共用这个宽度。
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--inspector-width", `${shownWidth}px`);
  }, [shownWidth]);
  useEffect(() => () => { document.documentElement.style.removeProperty("--inspector-width"); }, []);
  const closeInspector = () => { if (sources && !viewingOutside) setSources(null); else setInspectorHidden(panelKey); };
  /** 来源整理自己要关闭（Esc、安全模式下改成成人分级）：明确打开的收起，选择打开的取消选择。 */
  const closeSources = () => { if (sources) closeInspector(); else setSelected(new Set()); };
  /** 查看器的 I 键、dock 与右键菜单（#179）：显示或隐藏详情侧栏。 */
  const toggleInspector = () => {
    if (!inspectorOpen) { setInspectorHidden(null); return; }
    if (!viewingOutside) setSources(null);
    setInspectorHidden(panelKey);
  };

  return {
    selectionKey, selectionLibrary, selectedCards, eligible, inspected, inspectorContent, panelIds, inspectorOpen,
    setInspectorElement, inspectorMoving, draggedWidth, setDraggedWidth, panelWidth, closeInspector, closeSources, toggleInspector,
  };
}

export type WorkspaceInspectorState = ReturnType<typeof useWorkspaceInspector>;
