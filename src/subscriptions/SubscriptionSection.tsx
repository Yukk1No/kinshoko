import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { SubscriptionStatus } from "../bindings/SubscriptionStatus";
import { useTranslation } from "react-i18next";
import { NOTICE_ORDER, usePersistentToast, useToast } from "../ui/Toast";
import { accountActions } from "./accountActions";
import type { Section } from "../shell/Rail";
import { SubscriptionsMain } from "../pixiv/SubscriptionsMain";
import { useSubscriptionStatus } from "./useSubscriptionStatus";

/**
 * 主窗口的订阅分区（#368）：图标轨第四项，设置里的订阅功能开着时才出现。
 * 订阅功能关掉时入口消失，正开着的订阅页回到图片与文件夹。
 */
export function useSubscriptionSection(section: Section, setSection: Dispatch<SetStateAction<Section>>) {
  const [status, setStatus] = useSubscriptionStatus();
  const on = status?.enabled === true;
  /** 键盘快捷键（Ctrl+4）读它：监听只装一次。 */
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => {
    if (!on) setSection((current) => (current === "subscriptions" ? "browse" : current));
  }, [on, setSection]);
  return {
    status,
    setStatus,
    onRef,
    /** 订阅页正显示时它的状态，否则为 null。 */
    page: section === "subscriptions" && on ? status : null,
    rail: on ? { newCount: status.newCount } : null,
    settings: status && { status, onStatus: setStatus },
  };
}

/** pixiv 登录失效的通知（#433）：检查已经暂停，所以不管画师在哪一页都提示；登录窗口开着时先收起。 */
export function LoginExpiredNotice({
  subscriptions,
  hidden,
}: {
  subscriptions: ReturnType<typeof useSubscriptionSection>;
  hidden: boolean;
}) {
  const { t } = useTranslation("subscriptions");
  const toast = useToast();
  const { status, setStatus } = subscriptions;
  usePersistentToast(
    status?.enabled && status.login.state === "expired"
      ? {
          title: t("expired.notice"),
          action: {
            label: t("account.signInAgain"),
            onClick: () => accountActions((message) => toast.error(message), setStatus).signIn(),
          },
        }
      : null,
    { hidden: hidden || status?.signingIn === true, queue: NOTICE_ORDER.loginExpired },
  );
  return null;
}

/**
 * 订阅页（#461）：没有侧栏，应用内 pixiv 浏览占满工作区，与图片与文件夹的工作区并排切换。
 * `swap` 是切换的过渡（`usePageSwap`）：过渡中订阅页盖在图片页上淡入或淡出；关掉后淡出时用最后一次的状态。
 */
export function SubscriptionSection({
  subscriptions,
  swap = null,
  safe,
  onOpenSettings,
}: {
  subscriptions: ReturnType<typeof useSubscriptionSection>;
  swap?: "in" | "out-start" | "out" | null;
  safe: boolean;
  /** 标题行右端的“订阅设置”：打开设置 › 订阅。 */
  onOpenSettings: () => void;
}) {
  const last = useRef<SubscriptionStatus | null>(null);
  if (subscriptions.page) last.current = subscriptions.page;
  const leaving = !subscriptions.page && (swap === "out-start" || swap === "out");
  const page = subscriptions.page ?? (leaving ? last.current : null);
  if (!page) return null;
  return (
    <div
      className="app-workspace workspace"
      data-swap={swap === "in" ? "in" : leaving ? "out" : undefined}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
    >
      <div className="app-body">
        <SubscriptionsMain
          status={page}
          onStatus={subscriptions.setStatus}
          safe={safe}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}
