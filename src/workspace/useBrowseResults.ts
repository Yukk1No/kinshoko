import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { isLensChanged, workspaceStatus } from "../ipc";
import type { BrowsePageDelivery, BrowsePager } from "../wall/wallShared";
import {
  acceptBrowsePage,
  applyBrowseEvent,
  beginBrowse,
  initialBrowseResults,
  revokeBrowse,
  type BrowseInvalidationEvent,
  type BrowseResultsTransition,
} from "./browseResults";
import { onWorkspaceStatusNotice, workspaceStatusKey, workspaceStatusMirror } from "./workspaceStatusMirror";

export type Invalidate = (event: BrowseInvalidationEvent) => void;

/**
 * 工作区浏览结果的 React adapter。纯 transition 在 browseResults.ts；这里把同一步决定落到状态、
 * 图片墙重读与词表刷新。修订/登记状态的读取、事件订阅与退订由 workspaceStatusMirror（#741 镜像）承载。
 */
export function useBrowseResults({
  safe,
  onError,
  selected,
  viewerOpen,
  closeViewer,
  clearSources,
  setSelected,
  setResultCount,
  setReloadKey,
  setVocabularyKey,
}: {
  safe: boolean;
  onError: (error: unknown) => void;
  selected: ReadonlySet<string>;
  viewerOpen: boolean;
  closeViewer: () => void;
  clearSources: () => void;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setResultCount: Dispatch<SetStateAction<number | null>>;
  setReloadKey: Dispatch<SetStateAction<number>>;
  setVocabularyKey: Dispatch<SetStateAction<number>>;
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const model = useRef(initialBrowseResults);
  // 用户直接改选择或开关查看器时不经过失效 transition；渲染后同步进模型，下一次原子交付从当前事实出发。
  model.current = { ...model.current, selected, viewerOpen };
  const io = useRef({
    onError,
    closeViewer,
    clearSources,
    setSelected,
    setResultCount,
    setReloadKey,
    setVocabularyKey,
  });
  io.current = {
    onError,
    closeViewer,
    clearSources,
    setSelected,
    setResultCount,
    setReloadKey,
    setVocabularyKey,
  };
  const keyRef = useRef(workspaceStatusKey(safe));
  keyRef.current = workspaceStatusKey(safe);
  /** 已交给失效 transition 的镜像对象。读取进度变化的重复发布不是新快照，不能消掉在路上的“重新连接”。 */
  const mirrorValue = useRef<WorkspaceStatus | null>(null);

  const view = useCallback(() => ({ selected: model.current.selected, viewerOpen: model.current.viewerOpen }), []);

  const apply = useCallback((outcome: BrowseResultsTransition) => {
    model.current = outcome.state;
    const decision = outcome.decision;
    const current = io.current;
    if (decision.acceptStatus && outcome.state.status) setStatus(outcome.state.status);
    if (decision.closeViewer) current.closeViewer();
    if (decision.clearSources) current.clearSources();
    if (decision.clearSelection || decision.pruneSelection) current.setSelected(new Set(outcome.state.selected));
    if (decision.reload) current.setReloadKey((key) => key + 1);
    if (decision.refreshVocabulary) current.setVocabularyKey((key) => key + 1);
  }, []);

  const observe = useCallback(
    (next: WorkspaceStatus, origin: "mirror" | "notification" | "recheck", startedAt?: number) => {
      apply(applyBrowseEvent(model.current, { kind: "statusObserved", status: next, origin, startedAt }, view()));
    },
    [apply, view],
  );

  const invalidate = useCallback<Invalidate>(
    (event) => {
      const outcome = applyBrowseEvent(model.current, event, view());
      apply(outcome);
    },
    [apply, view],
  );

  // 安全模式视角变化时，修订身份也变化：旧视角接受的修订不作数，新视角的第一份镜像只是采用。
  // 镜像接受事件快照时同步通知这里的 listener，因此后端通知到达的同一刻就进入失效 transition。
  useEffect(() => {
    const key = workspaceStatusKey(safe);
    keyRef.current = key;
    apply(applyBrowseEvent(model.current, { kind: "statusRead" }, view()));
    mirrorValue.current = null;
    let lastError: unknown = null;
    const hearMirror = () => {
      const snapshot = workspaceStatusMirror.snapshot(key);
      if (snapshot.error !== lastError) {
        lastError = snapshot.error;
        if (snapshot.error && !isLensChanged(snapshot.error)) io.current.onError(snapshot.error);
      }
      if (snapshot.value && snapshot.value !== mirrorValue.current) {
        mirrorValue.current = snapshot.value;
        observe(snapshot.value, "mirror");
      }
    };
    const stopNotice = onWorkspaceStatusNotice((noticeKey, next) => {
      if (noticeKey !== key) return;
      mirrorValue.current = next;
      observe(next, "notification");
    });
    hearMirror();
    const stopMirror = workspaceStatusMirror.subscribe(key, hearMirror);
    return () => {
      stopNotice();
      stopMirror();
    };
  }, [safe, apply, observe, view]);

  /** “重新连接”：重新检查各图库是否可用；同修订也按画师要求重读一次。 */
  const recheck = useCallback(() => {
    const startedAt = model.current.invalidation.observations;
    void workspaceStatus(safe).then(
      (next) => observe(next, "recheck", startedAt),
      (error) => {
        if (!isLensChanged(error)) io.current.onError(error);
      },
    );
  }, [safe, observe]);

  const deliverRef = useRef<(page: BrowsePageDelivery) => boolean>(() => false);
  deliverRef.current = (page) => {
    const outcome = acceptBrowsePage(model.current, page, view());
    apply(outcome);
    if (outcome.acceptedPage) {
      // 这页带回的状态本身就是一份完整后端快照：写进状态镜像，出发更早、回来更晚的旧状态读取
      // 不能把它回滚（旧读取回滚后，同修订通知会被误判成又一次新修订）。
      mirrorValue.current = page.status;
      workspaceStatusMirror.accept(keyRef.current, page.status);
      io.current.setResultCount(page.total);
    }
    return outcome.acceptedPage;
  };
  const pagerRef = useRef<BrowsePager | null>(null);
  if (!pagerRef.current) {
    pagerRef.current = {
      begin: () => {
        const next = beginBrowse(model.current);
        model.current = next.state;
        return next.token;
      },
      token: () => model.current.generation,
      current: (token) => token === model.current.generation,
      invalidate: () => {
        model.current = revokeBrowse(model.current);
      },
      deliver: (page) => deliverRef.current(page),
    };
  }

  return { status, recheck, invalidate, pager: pagerRef.current };
}
