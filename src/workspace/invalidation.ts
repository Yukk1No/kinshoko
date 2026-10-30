// 工作区的失效决策（#324）：收到哪种事实，要撤销什么、关掉什么、重读什么。只做决定，不碰 React；
// 副作用由调用方按返回的决定执行（LibraryWorkspace 的 `useInvalidation`）。

/** 修订变化后的选择修剪进度：等图片墙读完新的结果，只保留仍在的图。 */
export type Prune = "idle" | "reset" | "loading";

export type InvalidationState = {
  /**
   * 已接受的工作区修订。修订号只是身份标记：只比是否相同，不比大小、不推断先后。
   * 状态读取按新视角重新发出时清为 null，表示这个视角下还没有接受过修订。
   */
  revision: string | null;
  /**
   * 观察序号：每接受一份状态快照或一次列表失效就前进。状态读取发出时记下它，
   * 回来时已经不同（期间有更新的事实）就整个作废，先发的读取不能覆盖后来的事实。
   */
  observations: number;
  prune: Prune;
};

export const initialInvalidation: InvalidationState = { revision: null, observations: 0, prune: "idle" };

/** 状态快照从哪里来：主动读取、变更通知、图片墙某页带回、“重新连接”。 */
export type StatusOrigin = "read" | "notification" | "page" | "recheck";

export type InvalidationEvent =
  /** 按当前视角发出状态读取（首次或安全模式视角变了）：之前接受的修订不再作数。 */
  | { kind: "statusRead" }
  /** 收到一份状态快照。`read`/`recheck` 带上发出时的观察序号。 */
  | { kind: "statusObserved"; revision: string; origin: StatusOrigin; startedAt?: number }
  /** 资料库说列表过时了（`listStale`），修订号不一定变。 */
  | { kind: "listInvalidated" }
  /** 词表或图片变了（`vocabularyChanged`、`imagesChanged`）。 */
  | { kind: "vocabularyInvalidated" }
  /** 读取途中结果集变了（游标过期）：那次结果作废，像收到通知一样重读。 */
  | { kind: "cursorExpired" }
  /** 界面里改了图（打标、删除、来源）：重读并刷新词表。 */
  | { kind: "contentEdited" }
  /** 查询用的安全模式视角变了。重读已在渲染阶段推进（#183），这里不再要。 */
  | { kind: "lensChanged"; keepSelection: boolean }
  /** 资料库确认安全模式已切换（`safeModeChanged`）。 */
  | { kind: "safeConfirmed"; on: boolean; keepSelection: boolean }
  /** 左栏换了浏览范围。 */
  | { kind: "scopeChanged" }
  /** 换了查找条件（搜索框、标签分组、打开回收站）。 */
  | { kind: "conditionsChanged" }
  /** 换了活动资料库。 */
  | { kind: "activeLibraryChanged" }
  /**
   * 图片墙交来的卡片或张数变了；`ready` 为张数已知（这一页读完）。
   * 顺序契约：图片墙先报这一页带回的状态（`statusObserved`，origin `page`），再交出这一页的卡片，
   * 所以那份状态要求的修剪落在这一页上。
   */
  | { kind: "pageAccepted"; ready: boolean };

export type Decision = {
  /** 采用这份状态快照（侧栏、登记）。 */
  acceptStatus: boolean;
  /** 撤销图片墙还在路上的请求的交付资格。 */
  revokeWall: boolean;
  closeViewer: boolean;
  clearSelection: boolean;
  clearSources: boolean;
  /** 只保留图片墙当前卡片里仍在的选中图。 */
  pruneSelection: boolean;
  /** 图片墙从头重读（保留卡片与阅读位置）。 */
  reload: boolean;
  refreshVocabulary: boolean;
};

const NOTHING: Decision = {
  acceptStatus: false, revokeWall: false, closeViewer: false, clearSelection: false, clearSources: false,
  pruneSelection: false, reload: false, refreshVocabulary: false,
};

export type Outcome = { state: InvalidationState; decision: Decision };

const keep = (state: InvalidationState): Outcome => ({ state, decision: NOTHING });
const act = (state: InvalidationState, decision: Partial<Decision>): Outcome => ({ state, decision: { ...NOTHING, ...decision } });

/** 修订前进后的整套动作：撤销旧内容、关查看器、读完后修剪、重读、刷新词表。 */
const REVISION_ADVANCED: Partial<Decision> = { closeViewer: true, reload: true, refreshVocabulary: true };

export function decide(state: InvalidationState, event: InvalidationEvent): Outcome {
  switch (event.kind) {
    case "statusRead":
      return keep({ ...state, revision: null, observations: state.observations + 1 });
    case "statusObserved": {
      const asked = event.origin === "read" || event.origin === "recheck";
      if (asked && event.startedAt !== state.observations) return keep(state);
      const observed = { ...state, observations: state.observations + 1 };
      if (observed.revision === event.revision) {
        // 同修订：只消重。“重新连接”是画师主动要的，仍按原修订重读一次。
        return event.origin === "recheck" ? act(observed, { reload: true }) : keep(observed);
      }
      // 通知与“重新连接”本身就说明内容变了；读取或页带回的新修订只在已有修订时才算前进
      // （这个视角下的第一份快照只是采用）。
      const pushed = event.origin === "notification" || event.origin === "recheck";
      const advanced = pushed || observed.revision !== null;
      const next = { ...observed, revision: event.revision, prune: advanced ? "reset" as const : observed.prune };
      return act(next, { acceptStatus: true, revokeWall: pushed, ...(advanced ? REVISION_ADVANCED : {}) });
    }
    case "listInvalidated":
      return act({ ...state, observations: state.observations + 1, prune: "reset" }, { revokeWall: true, reload: true });
    case "vocabularyInvalidated":
      return act(state, { refreshVocabulary: true });
    case "cursorExpired":
    case "contentEdited":
      return act(state, { reload: true, refreshVocabulary: true });
    case "lensChanged":
      // 变严不等重读：查看器当即关闭；按偏好当即清空选择，或等新结果就绪后修剪。
      return act({ ...state, prune: "reset" }, {
        closeViewer: true, refreshVocabulary: true,
        clearSelection: !event.keepSelection, clearSources: !event.keepSelection,
      });
    case "safeConfirmed":
      // 关闭时查询视角在确认那一刻才放开，由 lensChanged 那一路整批重读一次；这里再重读会作废它（#183）。
      if (!event.on) return keep(state);
      return act(state, { clearSelection: !event.keepSelection, closeViewer: true, reload: true, refreshVocabulary: true });
    case "scopeChanged":
      return act(state, { clearSelection: true, clearSources: true, closeViewer: true });
    case "conditionsChanged":
      return act(state, { clearSelection: true, closeViewer: true });
    case "activeLibraryChanged":
      return act(state, { clearSelection: true, clearSources: true, closeViewer: true, reload: true });
    case "pageAccepted":
      if (state.prune === "reset" && !event.ready) return keep({ ...state, prune: "loading" });
      if (state.prune === "idle" || !event.ready) return keep(state);
      return act({ ...state, prune: "idle" }, { pruneSelection: true });
  }
}
