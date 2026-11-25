import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { subscriptionMarkSeen } from "../ipc/subscriptions";
import { useToast } from "../ui/Toast";
import { WinCtrls } from "../ui/WinCtrls";
import { accountActions } from "../subscriptions/accountActions";
import { FirstRunDialog, firstRunSeen, markFirstRunSeen } from "../subscriptions/FirstRunDialog";
import { SubscriptionsEmpty } from "../subscriptions/SubscriptionsEmpty";
import { AccountFloat } from "./AccountFloat";
import { type DensityControl, PixivDensityContext } from "./density";
import { PixivHome } from "./PixivHome";
import { useSubscriptions } from "./useSubscriptions";

/**
 * 订阅页的主区（#461 第 8 步）：登录着（含登录失效，检查暂停时仍能逛）就是应用内 pixiv 浏览；没登录时只有
 * 一个登录的空状态。第一次打开、还没登录时先弹首次使用说明（#366）。打开这一页就把入口上的新图数标为已看。
 */
export function SubscriptionsMain({
  status,
  onStatus,
  safe,
  onOpenSettings,
  density = null,
  leaving = false,
}: {
  status: SubscriptionStatus;
  onStatus: (status: SubscriptionStatus) => void;
  safe: boolean;
  /** 头像卡里的“订阅设置”：打开设置 › 订阅。 */
  onOpenSettings: () => void;
  /** 图片大小，与图片页共用一个设置；头像卡里调。 */
  density?: DensityControl | null;
  /** 页面正在淡出：头像卡先放开通知锚点。 */
  leaving?: boolean;
}) {
  const { t } = useTranslation("subscriptions");
  const toast = useToast();
  const actions = accountActions((message) => toast.error(message), onStatus);
  const signedIn = status.login.state !== "loggedOut";
  const [firstRun, setFirstRun] = useState(() => !signedIn && !status.signingIn && !firstRunSeen());
  const closeFirstRun = () => {
    markFirstRunSeen();
    setFirstRun(false);
  };

  // 新图数沿用现有规则：打开订阅时标为已看；开着这一页时后台又收了新图，也当场标掉。
  const unseen = signedIn && status.newCount > 0;
  useEffect(() => {
    if (!unseen) return;
    // 忽略失败：没标上时入口上的数还在，下次再标。
    void subscriptionMarkSeen().catch(() => {});
  }, [unseen]);

  return (
    <main className="app-main pw-main" aria-label={t("title")}>
      {signedIn ? (
        <SignedInPixiv
          status={status}
          onStatus={onStatus}
          safe={safe}
          density={density}
          onOpenSettings={onOpenSettings}
          leaving={leaving}
        />
      ) : (
        <>
          <header className="topbar is-empty" data-tauri-drag-region>
            <span className="k-grow" />
            <WinCtrls />
          </header>
          <SubscriptionsEmpty signingIn={status.signingIn} actions={actions} setFirstRun={setFirstRun} />
        </>
      )}
      <FirstRunDialog
        open={firstRun}
        signedIn={signedIn}
        onClose={closeFirstRun}
        onSignIn={() => {
          closeFirstRun();
          actions.signIn();
        }}
      />
    </main>
  );
}
/** 登录后的那一半单独成组件：订阅名单只在需要时读，并由墙与头像卡共用。 */
function SignedInPixiv({
  status,
  onStatus,
  safe,
  density,
  onOpenSettings,
  leaving,
}: {
  status: SubscriptionStatus;
  onStatus: (status: SubscriptionStatus) => void;
  safe: boolean;
  density: DensityControl | null;
  onOpenSettings: () => void;
  leaving: boolean;
}) {
  const subs = useSubscriptions(safe, `${status.checking}:${status.newCount}`);
  return (
    <PixivDensityContext value={density?.value ?? null}>
      <PixivHome safe={safe} status={status} subs={subs} />
      <AccountFloat
        status={status}
        onStatus={onStatus}
        density={density}
        onOpenSettings={onOpenSettings}
        subscriptions={subs}
        leaving={leaving}
      />
    </PixivDensityContext>
  );
}
