import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import { onSubscriptionStatus, subscriptionStatus } from "../ipc/subscriptions";

const KEY = "subscription-status";

/** 订阅状态的后端镜像（#761）：事件携带完整状态，直接接受，先发出的旧读取不能盖掉它。 */
const statusMirror = createBackendMirror<typeof KEY, SubscriptionStatus>({
  read: () => subscriptionStatus(),
  listen: (_invalidate, accept) => onSubscriptionStatus((status) => accept(KEY, status)),
});

/** 写入流程自己已经拿到后端返回的完整状态时，把它交进同一镜像。 */
export function acceptSubscriptionStatus(status: SubscriptionStatus) {
  statusMirror.accept(KEY, status);
}

/**
 * 订阅状态（#368），跟着后端推送更新。`null`：订阅记录打不开，
 * 或还没读到；这时图标轨不显示入口、设置里没有订阅分页。
 * 返回的写入函数只接受已经完成的后端改动交回的完整状态，让各挂载点看到同一份真相。
 */
export function useSubscriptionStatus(): [SubscriptionStatus | null, (status: SubscriptionStatus) => void] {
  const { value } = useBackendMirror(statusMirror, KEY);
  return [value, acceptSubscriptionStatus];
}
