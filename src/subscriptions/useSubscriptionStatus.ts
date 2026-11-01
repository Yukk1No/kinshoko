import { useEffect, useState } from "react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { onSubscriptionStatus, subscriptionStatus } from "../ipc/subscriptions";

/**
 * 订阅状态（#368），跟着后端推送更新。`null`：这一版没有订阅功能（没设 `KINSHOKO_SUBSCRIPTIONS=1`），
 * 或还没读到；这时图标轨不显示入口、设置里没有订阅分页。
 */
export function useSubscriptionStatus(): [SubscriptionStatus | null, (status: SubscriptionStatus) => void] {
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  useEffect(() => {
    let alive = true;
    // 推送先到时以推送为准，之后读到的旧状态不再覆盖。
    let pushed = false;
    const stop = onSubscriptionStatus((next) => { pushed = true; if (alive) setStatus(next); });
    subscriptionStatus().then((next) => { if (alive && !pushed) setStatus(next); }, () => {});
    return () => { alive = false; void stop.then((fn) => fn(), () => {}); };
  }, []);
  return [status, setStatus];
}
