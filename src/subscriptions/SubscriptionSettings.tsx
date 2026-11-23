import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, RefreshCw, Rss, TriangleAlert, User } from "lucide-react";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import {
  setSubscriptionsEnabled,
  subscriptionCheckNow,
  subscriptions as listSubscriptions,
} from "../ipc/subscriptions";
import { useSaveDestination } from "../library/SaveDestination";
import { Select } from "../ui/Select";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { Switch } from "../ui/Switch";
import { accountActions } from "./accountActions";
import { checkedText, checkView, retryText, useNow } from "./checkStatus";
import { useLibraryOptions } from "./artistOptions";
import { FirstRunDialog } from "./FirstRunDialog";
import { UnofficialMark } from "./UnofficialMark";

/**
 * 设置 › 订阅（原型第 13–15 号画板）：订阅开关、pixiv 账号、检查新作、新订阅收进哪个图库与风险说明。
 * 关掉开关后图标轨不显示入口、不检查、不联网；关着时只留开关，已登录的账号仍可退出。
 * 订阅页（#461）没有侧栏，检查状态与“检查”从旧订阅页的标题行搬到这里。
 */
export function SubscriptionSettings({
  status,
  onStatus,
  error,
  onError,
}: {
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
        {on && <CheckRow status={status} onError={onError} />}
        {on && <NewSubscriptionsLibrary />}
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
 * 检查新作：上次什么时候同步、正在检查、限流后什么时候再试。空闲时有“检查”。没登录或还没有订阅时不显示。
 * 名单跟着检查开始、结束重读，好拿到每条订阅最近一次检查的时间。
 */
function CheckRow({ status, onError }: { status: SubscriptionStatus; onError: (message: string | null) => void }) {
  const { t } = useTranslation("subscriptions");
  const now = useNow();
  const [list, setList] = useState<Subscription[]>([]);
  const signedIn = status.login.state === "loggedIn";
  // biome-ignore lint/correctness/useExhaustiveDependencies(status.checking): 检查开始、结束是重读信号，effect 里不读它
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    listSubscriptions().then(
      (next) => alive && setList(next),
      () => alive && setList([]),
    );
    return () => {
      alive = false;
    };
  }, [signedIn, status.checking]);
  const view = checkView(status, list, now);
  if (view.kind === "none") return null;
  const meta =
    view.kind === "idle"
      ? checkedText(view.lastCheckedAt, now)
      : view.kind === "checking"
        ? t("check.checking")
        : retryText(view.until);
  return (
    <SettingsRow icon={<RefreshCw size={16} />} title={t("settings.check")} meta={<span role="status">{meta}</span>}>
      {view.kind === "idle" && (
        <button
          type="button"
          className="k-btn is-sm"
          onClick={() => {
            onError(null);
            subscriptionCheckNow().catch((e) => onError(t("check.failed", { error: errorText(e) })));
          }}
        >
          <span className="k-label">{t("check.now")}</span>
        </button>
      )}
    </SettingsRow>
  );
}

/**
 * 新订阅（关注、榜单开关、收藏开关、订阅画师）默认收进哪个图库。没选过时是“自动”：和同类订阅放一起，没有同类时
 * 收进应用内浏览上次亲手选的库（与 `useSubscriptions` 的挑法一致）。只管以后新加的订阅；已有的订阅在画师页、开关旁各自改。
 */
function NewSubscriptionsLibrary() {
  const { t } = useTranslation("subscriptions");
  const { memory, rememberSubscription } = useSaveDestination();
  const { options } = useLibraryOptions();
  if (!options.length) return null;
  const chosen = memory.subscriptionDestination?.libraryId;
  const value = chosen && options.some((o) => o.value === chosen) ? chosen : AUTO;
  return (
    <SettingsRow icon={<FolderInput size={16} />} title={t("settings.newSubscriptions")}>
      <Select
        label={t("settings.newSubscriptions")}
        value={value}
        options={[...(value === AUTO ? [{ value: AUTO, label: t("settings.newSubscriptionsAuto") }] : []), ...options]}
        onChange={(libraryId) => libraryId !== AUTO && rememberSubscription({ libraryId, folderId: null })}
      />
    </SettingsRow>
  );
}

const AUTO = "\u0000auto";
