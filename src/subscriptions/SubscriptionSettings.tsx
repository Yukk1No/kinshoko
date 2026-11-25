import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, RefreshCw, Rss, TriangleAlert, Trophy, User } from "lucide-react";
import type { Subscription } from "../bindings/Subscription";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { errorText } from "../ipc/commandError";
import {
  setSubscriptionsEnabled,
  subscriptionAdd,
  subscriptionCheckNow,
  subscriptionRemove,
  subscriptions as listSubscriptions,
} from "../ipc/subscriptions";
import { useOptionalToast } from "../ui/Toast";
import { displayName } from "./rankingNames";
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
 * 订阅页（#461）没有侧栏，检查状态与“检查”从旧订阅页的标题行搬到这里；以前订阅的 R-18 榜单也在这里取消。
 */
export function SubscriptionSettings({
  status,
  onStatus,
  error,
  onError,
  safe = false,
}: {
  status: SubscriptionStatus;
  /** 安全模式：开着时不列 R-18 榜单。 */
  safe?: boolean;
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
  const [list, setList] = useSubscriptionList(on && status.login.state === "loggedIn", status.checking);
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
        {on && <CheckRow status={status} list={list} onError={onError} />}
        {on && <NewSubscriptionsLibrary />}
        {on &&
          !safe &&
          list
            .filter(isExplicitRanking)
            .map((sub) => (
              <ExplicitRankingRow
                key={sub.id}
                subscription={sub}
                onError={onError}
                onRemoved={() => setList((l) => l.filter((x) => x.id !== sub.id))}
                onRestored={(back) => setList((l) => [...l, ...back])}
              />
            ))}
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

/** 订阅名单：登录着时读，检查开始、结束时重读（拿到每条订阅最近一次检查的时间）。 */
export function useSubscriptionList(signedIn: boolean, checking: boolean) {
  const [list, setList] = useState<Subscription[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies(checking): 检查开始、结束是重读信号，effect 里不读它
  useEffect(() => {
    if (!signedIn) {
      setList([]);
      return;
    }
    let alive = true;
    listSubscriptions().then(
      (next) => alive && setList(next),
      () => alive && setList([]),
    );
    return () => {
      alive = false;
    };
  }, [signedIn, checking]);
  return [list, setList] as const;
}

const isExplicitRanking = (sub: Subscription) => sub.target.kind === "pixivRanking" && sub.target.explicit;

/**
 * 以前订阅的 R-18 榜单（#370）。订阅页只读全年龄榜（#461），榜单页上没有它们的开关，所以在这里列出，能取消订阅；
 * 取消后轻提示带“撤销”，按原来的图库与设置订回来，只收之后的。
 */
function ExplicitRankingRow({
  subscription,
  onError,
  onRemoved,
  onRestored,
}: {
  subscription: Subscription;
  onError: (message: string | null) => void;
  onRemoved: () => void;
  onRestored: (back: Subscription[]) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const toast = useOptionalToast();
  const { options } = useLibraryOptions();
  const [busy, setBusy] = useState(false);
  const name = displayName(t, subscription);
  const library = options.find((o) => o.value === subscription.libraryId)?.label;
  const restore = () =>
    subscriptionAdd([
      {
        target: subscription.target,
        name: subscription.name,
        libraryId: subscription.libraryId,
        includeExplicit: subscription.includeExplicit,
        includeManga: subscription.includeManga,
        backlog: { kind: "newOnly" },
      },
    ]).then(onRestored, (e) => onError(t("browse.subscribeFailed", { error: errorText(e) })));
  const remove = () => {
    onError(null);
    setBusy(true);
    subscriptionRemove(subscription.id).then(
      () => {
        onRemoved();
        toast?.show({
          title: t("browse.unsubscribed", { name }),
          action: { label: t("browse.undo"), onClick: () => void restore() },
        });
      },
      (e) => {
        setBusy(false);
        onError(t("browse.unsubscribeFailed", { error: errorText(e) }));
      },
    );
  };
  return (
    <SettingsRow icon={<Trophy size={16} />} title={name} meta={library}>
      <button type="button" className="k-btn is-sm" disabled={busy} onClick={remove}>
        <span className="k-label">{t("browse.unsubscribe")}</span>
      </button>
    </SettingsRow>
  );
}

/**
 * 检查新作：上次什么时候同步、正在检查、限流后什么时候再试。空闲时有“检查”。没登录或还没有订阅时不显示。
 */
function CheckRow({
  status,
  list,
  onError,
}: {
  status: SubscriptionStatus;
  list: Subscription[];
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const now = useNow();
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
 * 设置 › 订阅与订阅页的头像卡共用。没有图库时为 null。
 */
export function useNewSubscriptionLibrary() {
  const { t } = useTranslation("subscriptions");
  const { memory, rememberSubscription } = useSaveDestination();
  const { options } = useLibraryOptions();
  if (!options.length) return null;
  const chosen = memory.subscriptionDestination?.libraryId;
  const value = chosen && options.some((o) => o.value === chosen) ? chosen : AUTO;
  return {
    value,
    options: [...(value === AUTO ? [{ value: AUTO, label: t("settings.newSubscriptionsAuto") }] : []), ...options],
    onChange: (libraryId: string) => libraryId !== AUTO && rememberSubscription({ libraryId, folderId: null }),
  };
}

function NewSubscriptionsLibrary() {
  const { t } = useTranslation("subscriptions");
  const library = useNewSubscriptionLibrary();
  if (!library) return null;
  return (
    <SettingsRow icon={<FolderInput size={16} />} title={t("settings.newSubscriptions")}>
      <Select label={t("settings.newSubscriptions")} {...library} />
    </SettingsRow>
  );
}

const AUTO = "\u0000auto";
