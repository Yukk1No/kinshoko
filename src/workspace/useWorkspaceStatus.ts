import { useCallback, useEffect, useState } from "react";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { isLensChanged, onWorkspaceChanged, workspaceStatus } from "../ipc";
import type { StatusOrigin } from "./invalidation";
import type { Invalidate } from "./useInvalidation";

export type { Prune } from "./invalidation";

/**
 * 工作区状态（各图库登记与修订）：首次读取、变更通知与“重新连接”。修订前进时怎样撤销旧内容、
 * 重读与刷新词表由失效决策（invalidation.ts）决定。
 */
export function useWorkspaceStatus({ safe, onError, invalidate, observations }: {
  safe: boolean;
  onError: (message: string) => void;
  invalidate: Invalidate;
  observations: () => number;
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const observe = useCallback((next: WorkspaceStatus, origin: StatusOrigin, startedAt?: number) => {
    if (invalidate({ kind: "statusObserved", revision: next.revision, origin, startedAt }).acceptStatus) setStatus(next);
  }, [invalidate]);
  const onWallStatus = useCallback((next: WorkspaceStatus) => { observe(next, "page"); }, [observe]);

  useEffect(() => {
    let alive = true;
    invalidate({ kind: "statusRead" });
    const startedAt = observations();
    // A response started before a notification cannot roll back the newer provider facts.
    void workspaceStatus(safe).then((next) => {
      if (alive) observe(next, "read", startedAt);
    }, (e) => { if (alive && observations() === startedAt && !isLensChanged(e)) onError(String(e)); });
    const stop = onWorkspaceChanged((next) => {
      if (!alive) return;
      // Keep the explicit source dialog; it revokes stale content and revalidates on reloadKey.
      // 负责人决定（2026-10-11）：修订变化不清空选择。图片墙按新修订重读完之后，
      // 只去掉已不存在的选中图（删除、移出当前范围），详情面板随之保持打开。
      observe(next, "notification");
    });
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [safe, onError, observe, invalidate, observations]);

  /** “重新连接”：重新检查各图库是否可用（移动盘接回后），与原“刷新登记”相同的只读检查。 */
  const recheck = useCallback(() => {
    const startedAt = observations();
    void workspaceStatus(safe).then((next) => { observe(next, "recheck", startedAt); },
      (e) => { if (!isLensChanged(e)) onError(String(e)); });
  }, [safe, onError, observe, observations]);

  return { status, onWallStatus, recheck };
}
