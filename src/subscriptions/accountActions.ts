import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import { subscriptionCancelLogin, subscriptionLogin, subscriptionLogout } from "../ipc/subscriptions";
import { i18n } from "../i18n/instance";

type Report = (message: string) => void;

/** 订阅页与设置共用的 pixiv 登录操作；失败时按界面语言报告。 */
export function accountActions(report: Report, accept: (status: SubscriptionStatus) => void) {
  return {
    signIn: () => {
      subscriptionLogin(i18n.t("subscriptions:account.windowTitle"))
        .catch((e) => report(i18n.t("subscriptions:account.failed", { error: errorText(e) })));
    },
    cancel: () => { subscriptionCancelLogin().then(accept, (e) => report(errorText(e))); },
    signOut: () => {
      subscriptionLogout().then(accept, (e) => report(i18n.t("subscriptions:account.signOutFailed", { error: errorText(e) })));
    },
  };
}
