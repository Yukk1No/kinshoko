import type { NewSubscription } from "../bindings/NewSubscription";
import type { Subscription } from "../bindings/Subscription";
import { createBackendMirror } from "../ipc/backendMirror";
import { useBackendMirror } from "../ipc/useBackendMirror";
import {
  onSubscriptionStatus,
  subscriptionAdd,
  subscriptionRemove,
  subscriptions as listSubscriptions,
} from "../ipc/subscriptions";

/**
 * 本机订阅名单的唯一后端镜像（#741）。订阅页与设置 › 订阅都从这里读；写入成功后才用 `accept` 写回，
 * 因此重读先发出、写入先完成、旧名单后返回时，退订结果不会被盖掉。名单真相仍在后端订阅记录里。
 */
const KEY = "local-subscriptions";

const localSubscriptionsMirror = createBackendMirror<typeof KEY, Subscription[]>({
  read: () => listSubscriptions(),
  listen: (invalidate) => onSubscriptionStatus(() => invalidate(KEY)),
});

/** 订阅名单镜像。`enabled` 为 false 时不订阅后端事件，也不发读取。 */
export function useLocalSubscriptions(enabled = true) {
  return useBackendMirror(localSubscriptionsMirror, KEY, enabled);
}

export function invalidateLocalSubscriptions() {
  localSubscriptionsMirror.invalidate(KEY);
}

function updateList(update: (current: Subscription[]) => Subscription[]) {
  const current = localSubscriptionsMirror.snapshot(KEY).value;
  // 写入已经完成但镜像还没读到任何名单：不能拿局部改动冒充完整名单，改成重新读完整的一份。
  if (current === null) {
    invalidateLocalSubscriptions();
    return;
  }
  localSubscriptionsMirror.accept(KEY, update(current));
}

/** 对话框或写入流程自己已经调过后端添加命令时，把后端返回的完整新条目交进镜像。 */
export function acceptAddedLocalSubscriptions(added: Subscription[]) {
  // 后端写入会先推订阅状态、再回命令结果；抢先完成的重读可能已经带着新订阅，合并按 id 幂等。
  const ids = new Set(added.map((sub) => sub.id));
  updateList((current) => [...current.filter((sub) => !ids.has(sub.id)), ...added]);
}

export function acceptSavedLocalSubscriptions(saved: Subscription[]) {
  const byId = new Map(saved.map((sub) => [sub.id, sub]));
  updateList((current) => current.map((sub) => byId.get(sub.id) ?? sub));
}

function acceptRemovedLocalSubscription(id: string) {
  updateList((current) => current.filter((sub) => sub.id !== id));
}

/** 添加订阅并写进同一镜像；后端拒绝时不改镜像。 */
export async function addLocalSubscriptions(subscriptions: NewSubscription[]): Promise<Subscription[]> {
  const added = await subscriptionAdd(subscriptions);
  acceptAddedLocalSubscriptions(added);
  return added;
}

/** 退订并写进同一镜像；已收进图库的图不受影响。 */
export async function removeLocalSubscription(subscription: Subscription): Promise<void> {
  await subscriptionRemove(subscription.id);
  acceptRemovedLocalSubscription(subscription.id);
}

/** 撤销退订时的新订阅：按原来的资料库与收取范围，只收之后的新作。 */
function restoredSubscription(subscription: Subscription): NewSubscription {
  return {
    target: subscription.target,
    name: subscription.name,
    libraryId: subscription.libraryId,
    includeExplicit: subscription.includeExplicit,
    includeManga: subscription.includeManga,
    backlog: { kind: "newOnly" },
    ...(subscription.target.kind === "pixivBookmarks" && { privateBacklog: { kind: "newOnly" as const } }),
  };
}

/** 撤销退订并写进同一镜像。 */
export async function restoreLocalSubscriptions(subscriptions: Subscription[]): Promise<Subscription[]> {
  return addLocalSubscriptions(subscriptions.map(restoredSubscription));
}
