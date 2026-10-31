import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Rss, TriangleAlert, User } from "lucide-react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import { setSubscriptionsEnabled } from "../ipc/subscriptions";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";
import { accountActions } from "./accountActions";
import { FirstRunDialog } from "./FirstRunDialog";
import { UnofficialMark } from "./UnofficialMark";

/**
 * 设置 › 订阅（原型第 13–15 号画板）：订阅开关、pixiv 账号与风险说明。关掉开关后侧栏不显示入口、
 * 不检查、不联网；关着时只留开关，已登录的账号仍可退出。
 */
export function SubscriptionSettings({ status, onStatus, error, onError }: {
  status: SubscriptionStatus;
  /** 设置页的错误行，排在标题下面。 */
  error: string | null;
  onStatus: (status: SubscriptionStatus) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const [risks, setRisks] = useState(false);
  const on = status.enabled;
  const account = status.login.state === "loggedOut" ? null : status.login.account;
  const actions = accountActions(onError, onStatus);
  const toggle = (next: boolean) => {
    onError(null);
    setSubscriptionsEnabled(next).then(onStatus, (e) => onError(t("settings.switchFailed", { error: errorText(e) })));
  };
  return <>
    <div className="subs-settings-head">
      <h3 className="k-set-title">{t("settings.tab")}</h3>
      <UnofficialMark />
    </div>
    {error !== null && <p className="k-set-error" role="alert">{error}</p>}
    <p className="k-set-note subs-settings-lead">{t("settings.lead")}</p>
    <SettingsGroup label={t("settings.group")}>
      <SettingsRow icon={<Rss size={16} />} title={t("settings.feature")} hint={on ? t("settings.onHint") : t("settings.offHint")}>
        <Switch label={t("settings.feature")} checked={on} onCheckedChange={toggle} />
      </SettingsRow>
      {(on || account) && <SettingsRow icon={<User size={16} />} title={t("settings.account")}
        meta={account ? account.name : t("settings.signedOut")}>
        {account
          ? <button type="button" className="k-btn is-sm" onClick={actions.signOut}><span className="k-label">{t("account.signOut")}</span></button>
          : <button type="button" className="k-btn is-sm is-primary" onClick={actions.signIn}><span className="k-label">{t("account.signIn")}</span></button>}
      </SettingsRow>}
      {on && <SettingsRow icon={<TriangleAlert size={16} />} title={t("settings.risks")} hint={t("settings.risksHint")}>
        <button type="button" className="k-btn is-sm" onClick={() => setRisks(true)}><span className="k-label">{t("settings.view")}</span></button>
      </SettingsRow>}
    </SettingsGroup>
    <FirstRunDialog open={risks} signedIn={account !== null} onClose={() => setRisks(false)}
      onSignIn={() => { setRisks(false); actions.signIn(); }} />
  </>;
}
