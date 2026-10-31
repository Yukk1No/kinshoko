import type { SourceError } from "../bindings/SourceError";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { i18n } from "../i18n/instance";
import { formatDateTime } from "../i18n/format";

/**
 * 订阅页主区标题行右侧的检查状态（维护者对原型第 10 号画板的评论）：空闲时“同步于几分钟前”加立即检查，
 * 检查中、退避中只有一句话。登录失效时由横幅说明，这里不显示。
 */
export type CheckView =
  | { kind: "idle"; lastCheckedAt: number | null }
  | { kind: "checking" }
  | { kind: "backoff"; until: number }
  | { kind: "none" };

export function checkView(status: SubscriptionStatus, list: Subscription[], now: number): CheckView {
  if (status.login.state !== "loggedIn" || list.length === 0) return { kind: "none" };
  if (status.checking) return { kind: "checking" };
  if (status.backoffUntil !== null && status.backoffUntil > now) return { kind: "backoff", until: status.backoffUntil };
  const checked = list.map((s) => s.lastCheckedAt).filter((at): at is number => at !== null);
  return { kind: "idle", lastCheckedAt: checked.length > 0 ? Math.max(...checked) : null };
}

const MINUTE = 60_000;

/** “同步于 10 分钟前”。 */
export function checkedText(lastCheckedAt: number | null, now: number): string {
  if (lastCheckedAt === null) return i18n.t("subscriptions:check.never");
  const minutes = Math.floor(Math.max(0, now - lastCheckedAt) / MINUTE);
  if (minutes < 1) return i18n.t("subscriptions:check.justNow");
  if (minutes < 60) return i18n.t("subscriptions:check.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t("subscriptions:check.hours", { count: hours });
  return i18n.t("subscriptions:check.days", { count: Math.floor(hours / 24) });
}

/** “将于 14:30 同步”。 */
export function retryText(until: number): string {
  return i18n.t("subscriptions:check.retryAt", { time: formatDateTime(until, { hour: "2-digit", minute: "2-digit", hour12: false }) });
}

/** 名单上警示图标的说明：上次没查完的原因。 */
export function failureText(error: SourceError): string {
  const reason = error.code === "status"
    ? i18n.t("subscriptions:reason.status", { status: error.status })
    : i18n.t(`subscriptions:reason.${error.code}`);
  return i18n.t("subscriptions:lastFailedTip", { reason });
}
