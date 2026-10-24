import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { isLensChanged, onWorkspaceChanged, workspaceStatus } from "../ipc";
import type { BrowserCard, WallHandle } from "../wall/Wall";

/** 修订变化后的选择修剪进度（见 LibraryWorkspace 的 `prune`）。 */
export type Prune = "idle" | "reset" | "loading";

/**
 * 工作区状态（各图库登记与修订）：首次读取、变更通知与“重新连接”。修订前进时撤销旧内容，
 * 让图片墙重读、词表刷新。
 */
export function useWorkspaceStatus({ safe, onError, wall, prune, setViewing, setReloadKey, setVocabularyKey }: {
  safe: boolean;
  onError: (message: string) => void;
  wall: RefObject<WallHandle | null>;
  prune: RefObject<Prune>;
  setViewing: Dispatch<SetStateAction<BrowserCard | null>>;
  setReloadKey: Dispatch<SetStateAction<number>>;
  setVocabularyKey: Dispatch<SetStateAction<number>>;
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const statusRevision = useRef<string | null>(null);
  /** 已接受的查询或通知都会前进；先发的状态读取不能覆盖后来的事实。 */
  const statusObservations = useRef(0);
  const acceptStatus = useCallback((next: WorkspaceStatus, invalidateWall = false) => {
    statusObservations.current += 1;
    if (statusRevision.current === next.revision) return;
    if (invalidateWall) wall.current?.invalidate();
    const changed = statusRevision.current !== null;
    statusRevision.current = next.revision;
    setStatus(next);
    // 新快照先于通知到达时，同样撤销旧内容并刷新依赖；之后的同修订通知只消重。
    if (changed || invalidateWall) {
      setViewing(null);
      prune.current = "reset";
      setReloadKey((k) => k + 1);
      setVocabularyKey((k) => k + 1);
    }
  }, []);
  const onWallStatus = useCallback((next: WorkspaceStatus) => { acceptStatus(next); }, [acceptStatus]);

  useEffect(() => {
    let alive = true;
    const startedAtObservation = ++statusObservations.current;
    statusRevision.current = null;
    // A response started before a notification cannot roll back the newer provider facts.
    void workspaceStatus(safe).then((next) => {
      if (alive && statusObservations.current === startedAtObservation) acceptStatus(next);
    }, (e) => { if (alive && statusObservations.current === startedAtObservation && !isLensChanged(e)) onError(String(e)); });
    const stop = onWorkspaceChanged((next) => {
      if (!alive) return;
      // Keep the explicit source dialog; it revokes stale content and revalidates on reloadKey.
      // 负责人决定（2026-10-11）：修订变化不清空选择。图片墙按新修订重读完之后，
      // 只去掉已不存在的选中图（删除、移出当前范围），详情面板随之保持打开。
      acceptStatus(next, true);
    });
    return () => { alive = false; void stop.then((stop) => stop()); };
  }, [safe, onError, acceptStatus]);

  /** “重新连接”：重新检查各图库是否可用（移动盘接回后），与原“刷新登记”相同的只读检查。 */
  const recheck = useCallback(() => {
    const startedAtObservation = statusObservations.current;
    void workspaceStatus(safe).then((next) => {
      if (statusObservations.current !== startedAtObservation) return;
      const changed = statusRevision.current !== next.revision;
      acceptStatus(next, true);
      if (!changed) setReloadKey((k) => k + 1);
    }, (e) => { if (!isLensChanged(e)) onError(String(e)); });
  }, [safe, onError, acceptStatus]);

  return { status, statusObservations, onWallStatus, recheck };
}
