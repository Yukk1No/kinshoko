// 浏览结果的原子交付（#742）：一页的修订、卡片、总数、选择修剪与查看器开闭在同一个 transition 里决定。
// 图片墙仍负责发出分页请求与保持滚动位置；这里只做接受/拒绝响应、失效与最终投影，不碰 React。
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { pagesOf } from "../wall/imageSets";
import type { BrowserCard, BrowsePageDelivery } from "../wall/wallShared";
import {
  decide,
  initialInvalidation,
  type Decision,
  type InvalidationEvent,
  type InvalidationState,
  type StatusOrigin,
} from "./invalidation";

/** 浏览结果投影里与界面交互有关、但又会被失效决定改写的两项。 */
export type BrowseView = {
  selected: ReadonlySet<string>;
  viewerOpen: boolean;
};

export type BrowseResultsState = BrowseView & {
  invalidation: InvalidationState;
  /** 浏览响应令牌代次：只有当代响应可以交付。失效决定收拢在这里，调用方不再另记顺序契约。 */
  generation: number;
  status: WorkspaceStatus | null;
  cards: BrowserCard[];
  /** 画师看到的总张数（叠放时按各页计），不是分页游标或滚动状态。 */
  total: number | null;
};

export const initialBrowseResults: BrowseResultsState = {
  invalidation: initialInvalidation,
  generation: 0,
  status: null,
  cards: [],
  total: null,
  selected: new Set(),
  viewerOpen: false,
};

/** 调用方会报的失效事实；状态读取与状态快照是模块内部事实，不属于这道接缝。 */
export type BrowseInvalidationEvent =
  | { kind: "listInvalidated" }
  | { kind: "vocabularyInvalidated" }
  | { kind: "cursorExpired" }
  | { kind: "contentEdited" }
  | { kind: "lensChanged"; keepSelection: boolean }
  | { kind: "safeConfirmed"; on: boolean; keepSelection: boolean }
  | { kind: "scopeChanged" }
  | { kind: "conditionsChanged" };

/** 模块内部接受的全部事实：调用方报的失效，加上状态读取与状态快照。 */
export type BrowseResultsEvent =
  | BrowseInvalidationEvent
  | { kind: "statusRead" }
  | { kind: "statusObserved"; status: WorkspaceStatus; origin: StatusOrigin; startedAt?: number };

export type BrowseResultsTransition = {
  state: BrowseResultsState;
  decision: Decision;
  acceptedPage: boolean;
};

const NOTHING: Decision = {
  acceptStatus: false,
  revokeWall: false,
  closeViewer: false,
  clearSelection: false,
  clearSources: false,
  pruneSelection: false,
  reload: false,
  refreshVocabulary: false,
};

const orDecision = (a: Decision, b: Decision): Decision => ({
  acceptStatus: a.acceptStatus || b.acceptStatus,
  revokeWall: a.revokeWall || b.revokeWall,
  closeViewer: a.closeViewer || b.closeViewer,
  clearSelection: a.clearSelection || b.clearSelection,
  clearSources: a.clearSources || b.clearSources,
  pruneSelection: a.pruneSelection || b.pruneSelection,
  reload: a.reload || b.reload,
  refreshVocabulary: a.refreshVocabulary || b.refreshVocabulary,
});

const invalidationEvent = (event: BrowseResultsEvent): InvalidationEvent =>
  event.kind === "statusObserved" ? { ...event, revision: event.status.revision } : event;

const presentIds = (cards: readonly BrowserCard[]) => new Set(pagesOf([...cards]).map((card) => card.id));
const prune = (selected: ReadonlySet<string>, cards: readonly BrowserCard[]) => {
  const present = presentIds(cards);
  return new Set([...selected].filter((id) => present.has(id)));
};

function project(
  state: BrowseResultsState,
  invalidation: InvalidationState,
  decision: Decision,
  view: BrowseView,
  page?: { cards: BrowserCard[]; total: number },
): BrowseResultsState {
  const cards = page?.cards ?? state.cards;
  const selected = decision.clearSelection
    ? new Set<string>()
    : decision.pruneSelection
      ? prune(view.selected, cards)
      : view.selected;
  return {
    ...state,
    invalidation,
    generation: decision.revokeWall ? state.generation + 1 : state.generation,
    cards,
    total: page?.total ?? state.total,
    selected,
    viewerOpen: decision.closeViewer ? false : view.viewerOpen,
  };
}

function projectStatus(
  state: BrowseResultsState,
  invalidation: InvalidationState,
  decision: Decision,
  status: WorkspaceStatus | null,
  view: BrowseView,
  page?: { cards: BrowserCard[]; total: number },
): BrowseResultsState {
  const projected = project(state, invalidation, decision, view, page);
  return decision.acceptStatus && status ? { ...projected, status } : projected;
}

/** 开始一次从头浏览；旧响应全部失去交付资格。 */
export function beginBrowse(state: BrowseResultsState): { state: BrowseResultsState; token: number } {
  const generation = state.generation + 1;
  return { state: { ...state, generation }, token: generation };
}

/** 视图自身让旧响应作废（换视角、卸载、先移走卡片）；这不等于资料库失效，因此不产生重读决定。 */
export function revokeBrowse(state: BrowseResultsState): BrowseResultsState {
  return { ...state, generation: state.generation + 1 };
}

/** 接受一个失效事实，返回要由界面执行的重读、关闭与刷新决定。 */
export function applyBrowseEvent(
  state: BrowseResultsState,
  event: BrowseResultsEvent,
  view: BrowseView = { selected: state.selected, viewerOpen: state.viewerOpen },
): BrowseResultsTransition {
  const outcome = decide(state.invalidation, invalidationEvent(event));
  const status = event.kind === "statusObserved" ? event.status : null;
  return {
    state: projectStatus(state, outcome.state, outcome.decision, status, view),
    decision: outcome.decision,
    acceptedPage: false,
  };
}

/**
 * 原子接受一页。`statusObserved` 与 `pageAccepted` 在这里合成一个 transition：调用方只交完整的一页，
 * 不再负责“先报修订、再交卡片”的顺序。令牌不属于当代时整页丢弃，卡片、总数、选择与查看器都不动。
 */
export function acceptBrowsePage(
  state: BrowseResultsState,
  page: BrowsePageDelivery,
  view: BrowseView = { selected: state.selected, viewerOpen: state.viewerOpen },
): BrowseResultsTransition {
  if (page.token !== state.generation) return { state, decision: NOTHING, acceptedPage: false };
  const statusOutcome = decide(state.invalidation, {
    kind: "statusObserved",
    revision: page.status.revision,
    origin: "page",
  });
  const pageOutcome = decide(statusOutcome.state, { kind: "pageAccepted", ready: true });
  const decision = orDecision(statusOutcome.decision, pageOutcome.decision);
  return {
    state: projectStatus(state, pageOutcome.state, decision, page.status, view, {
      cards: page.cards,
      total: page.total,
    }),
    decision,
    acceptedPage: true,
  };
}
