import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { usePersistentToast, useToast } from "../ui/Toast";
import { accountActions } from "./accountActions";
import type { Section } from "../shell/Rail";
import { SubscriptionsPage } from "./SubscriptionsPage";
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
  useEffect(() => { if (!on) setSection((current) => (current === "subscriptions" ? "browse" : current)); }, [on, setSection]);
  return {
    status, setStatus, onRef,
    /** 订阅页正显示时它的状态，否则为 null。 */
    page: section === "subscriptions" && on ? status : null,
    rail: on ? { newCount: status.newCount } : null,
    settings: status && { status, onStatus: setStatus },
  };
}

/** pixiv 登录失效的通知（#433）：检查已经暂停，所以不管画师在哪一页都提示；登录窗口开着时先收起。 */
export function LoginExpiredNotice({ subscriptions, hidden }: { subscriptions: ReturnType<typeof useSubscriptionSection>; hidden: boolean }) {
  const { t } = useTranslation("subscriptions");
  const toast = useToast();
  const { status, setStatus } = subscriptions;
  usePersistentToast(status?.enabled && status.login.state === "expired"
    ? { title: t("expired.notice"), action: { label: t("account.signInAgain"), onClick: () => accountActions((message) => toast.error(message), setStatus).signIn() } }
    : null, { hidden: hidden || status?.signingIn === true });
  return null;
}

/** 订阅页占满工作区（侧栏与主区），与图片与文件夹的工作区并排切换。 */
export function SubscriptionSection({ subscriptions, safe, paneOpen, onPaneToggle, onOpenImage }: {
  subscriptions: ReturnType<typeof useSubscriptionSection>;
  safe: boolean;
  /** 当前打开的资料库：新订阅默认收进这里。 */
  paneOpen: boolean;
  onPaneToggle: () => void;
  onOpenImage: (libraryId: string, imageId: string) => void;
}) {
  if (!subscriptions.page) return null;
  return <div className="app-workspace workspace"><div className="app-body">
    <SubscriptionsPage status={subscriptions.page} onStatus={subscriptions.setStatus} safe={safe} paneOpen={paneOpen}
      onPaneToggle={onPaneToggle} onOpenImage={onOpenImage} />
  </div></div>;
}
