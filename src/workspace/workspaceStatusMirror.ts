// 工作区修订/登记状态的后端镜像（#742）：读取、事件订阅、退订、代次防乱序与过期重试都交给
// #741 的单一镜像原语。安全模式视角是查询键的一部分；事件携带完整状态时同步接受，迟到的旧读取不能盖掉它。
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { createBackendMirror, type BackendMirror } from "../ipc/backendMirror";
import { isLensChanged } from "../ipc/tagsAndSearch";
import { onWorkspaceChanged, workspaceStatus } from "../ipc/workspace";

export type WorkspaceStatusKey = "workspace-status:safe" | "workspace-status:full";

export const workspaceStatusKey = (safe: boolean): WorkspaceStatusKey =>
  safe ? "workspace-status:safe" : "workspace-status:full";

const counts = new Map<WorkspaceStatusKey, number>();
const activeKeys = () => [...counts].filter(([, count]) => count > 0).map(([key]) => key);
const noticeListeners = new Set<(key: WorkspaceStatusKey, status: WorkspaceStatus) => void>();

/** 后端通知先于镜像接受同步交给浏览结果模块：通知本身就说明内容变了，哪怕它是这个视角的第一份快照。 */
export function onWorkspaceStatusNotice(listener: (key: WorkspaceStatusKey, status: WorkspaceStatus) => void) {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

const inner = createBackendMirror<WorkspaceStatusKey, WorkspaceStatus>({
  read: (key) => workspaceStatus(key === "workspace-status:safe"),
  stale: isLensChanged,
  listen: (invalidate, accept) =>
    onWorkspaceChanged((status) => {
      const keys = activeKeys();
      // 工作区同一时刻只订阅一个安全模式视角。视角确认切换的短暂重叠里不能判断事件属于哪边，
      // 退回去重读；平时事件本身就是完整真相，同步接受才能立刻作废旧浏览响应。
      if (keys.length === 1) {
        for (const listener of [...noticeListeners]) listener(keys[0], status);
        accept(keys[0], status);
      } else invalidate();
    }),
});

/** 工作区状态镜像。不要直接新建第二份：订阅生命周期与事件退订只在它里面。 */
export const workspaceStatusMirror: BackendMirror<WorkspaceStatusKey, WorkspaceStatus> = {
  subscribe(key, listener) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const stopInner = inner.subscribe(key, listener);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const count = (counts.get(key) ?? 1) - 1;
      if (count) counts.set(key, count);
      else counts.delete(key);
      stopInner();
    };
  },
  snapshot: (key) => inner.snapshot(key),
  invalidate: (key) => inner.invalidate(key),
  accept: (key, value) => inner.accept(key, value),
};
