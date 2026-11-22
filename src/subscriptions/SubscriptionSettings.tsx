import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, Rss, TriangleAlert, User } from "lucide-react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import { setSubscriptionsEnabled } from "../ipc/subscriptions";
import { useSaveDestination } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";
import { accountActions } from "./accountActions";
import { useLibraryOptions } from "./artistOptions";
import { FirstRunDialog } from "./FirstRunDialog";
import { UnofficialMark } from "./UnofficialMark";

/**
 * 设置 › 订阅（原型第 13–15 号画板）：订阅开关、pixiv 账号与风险说明。关掉开关后侧栏不显示入口、
 * 不检查、不联网；关着时只留开关，已登录的账号仍可退出。`browse` 时（应用内浏览接上以后，#461 第 8 步）多一行
 * “新订阅收进”。
 */
export function SubscriptionSettings({
  status,
  onStatus,
  error,
  onError,
  browse = false,
}: {
  status: SubscriptionStatus;
  browse?: boolean;
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
  return (
    <>
      <div className="subs-settings-head">
        <h3 className="k-title">{t("settings.tab")}</h3>
        <UnofficialMark />
      </div>
      {error !== null && (
        <p className="k-error-text is-boxed" role="alert">
          {error}
        </p>
      )}
      <SettingsGroup label={t("settings.group")}>
        <SettingsRow icon={<Rss size={16} />} title={t("settings.feature")}>
          <Switch label={t("settings.feature")} checked={on} onCheckedChange={toggle} />
        </SettingsRow>
        {(on || account) && (
          <SettingsRow
            icon={<User size={16} />}
            title={t("settings.account")}
            meta={account ? account.name : t("settings.signedOut")}
            warn={on && status.login.state === "expired" && <span role="status">{t("expired.notice")}</span>}
          >
            {on && status.login.state === "expired" && (
              <button type="button" className="k-btn is-sm is-primary" onClick={actions.signIn}>
                <span className="k-label">{t("account.signInAgain")}</span>
              </button>
            )}
            {account ? (
              <button type="button" className="k-btn is-sm" onClick={actions.signOut}>
                <span className="k-label">{t("account.signOut")}</span>
              </button>
            ) : (
              <button type="button" className="k-btn is-sm is-primary" onClick={actions.signIn}>
                <span className="k-label">{t("account.signIn")}</span>
              </button>
            )}
          </SettingsRow>
        )}
        {on && browse && <NewSubscriptionsLibrary />}
        {on && (
          <SettingsRow icon={<TriangleAlert size={16} />} title={t("settings.risks")} hint={t("settings.risksHint")}>
            <button type="button" className="k-btn is-sm" onClick={() => setRisks(true)}>
              <span className="k-label">{t("settings.view")}</span>
            </button>
          </SettingsRow>
        )}
      </SettingsGroup>
      <FirstRunDialog
        open={risks}
        signedIn={account !== null}
        onClose={() => setRisks(false)}
        onSignIn={() => {
          setRisks(false);
          actions.signIn();
        }}
      />
    </>
  );
}

/**
 * 新订阅（关注、榜单开关、收藏开关、订阅画师）默认收进哪个图库。没选过时显示现在会用的：应用内浏览上次亲手选的，
 * 没有就是第一个图库。只管以后新加的订阅；已有的订阅在画师页、开关旁各自改。
 */
function NewSubscriptionsLibrary() {
  const { t } = useTranslation("subscriptions");
  const { memory, rememberSubscription } = useSaveDestination();
  const { options } = useLibraryOptions();
  if (!options.length) return null;
  const usable = (id: string | undefined) => (id && options.some((o) => o.value === id) ? id : null);
  const value =
    usable(memory.subscriptionDestination?.libraryId) ?? usable(memory.pixivDestination?.libraryId) ?? options[0].value;
  return (
    <SettingsRow icon={<FolderInput size={16} />} title={t("settings.newSubscriptions")}>
      <Select
        label={t("settings.newSubscriptions")}
        value={value}
        options={options}
        onChange={(libraryId) => rememberSubscription({ libraryId, folderId: null })}
      />
    </SettingsRow>
  );
}
