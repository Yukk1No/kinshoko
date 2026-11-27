import type { CaptureEntry } from "../bindings/CaptureEntry";
import type { GroupSummary } from "../bindings/GroupSummary";
import type { ReferenceGroupView } from "../bindings/ReferenceGroupView";
import { captureHistory, onCaptureHistory, onReferenceGroupsChanged, referenceGroup, referenceGroups } from "../ipc";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";

const CAPTURE_HISTORY_KEY = "capture-history";

/** 截图历史的共享后端镜像（#778）：图标轨角标与截图面板共用同一份读取与事件订阅。 */
const captureHistoryMirror = createBackendMirror<typeof CAPTURE_HISTORY_KEY, CaptureEntry[]>({
  read: () => captureHistory(),
  listen: (_invalidate, accept) => onCaptureHistory((entries) => accept(CAPTURE_HISTORY_KEY, entries)),
});

export function useCaptureHistory(enabled = true) {
  return useBackendMirror(captureHistoryMirror, CAPTURE_HISTORY_KEY, enabled);
}

const REFERENCE_GROUPS_KEY = "reference-groups";

/** 参考组名单的共享后端镜像（#778）：图标轨角标继续用 `referenceGroups()` 的全部名单计数。 */
const referenceGroupsMirror = createBackendMirror<typeof REFERENCE_GROUPS_KEY, GroupSummary[]>({
  read: () => referenceGroups(),
  listen: (invalidate) => onReferenceGroupsChanged(() => invalidate(REFERENCE_GROUPS_KEY)),
});

export function useReferenceGroups(enabled = true) {
  return useBackendMirror(referenceGroupsMirror, REFERENCE_GROUPS_KEY, enabled);
}

/** 桌面上一个参考组的成员视图，按参考组 id 建键；事件不带成员真相，失效后重读。 */
const deskGroupViewMirror = createBackendMirror<string, ReferenceGroupView>({
  read: (groupId) => referenceGroup(groupId),
  listen: (invalidate) => onReferenceGroupsChanged(() => invalidate()),
});

export function useDeskGroupView(groupId: string, enabled = true) {
  return useBackendMirror(deskGroupViewMirror, groupId, enabled);
}
