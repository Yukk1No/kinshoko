import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Section } from "../shell/Rail";
import { SubscriptionsPage } from "./SubscriptionsPage";
import { useSubscriptionStatus } from "./useSubscriptionStatus";

/**
 * 主窗口的订阅分区（#368）：图标轨第四项，订阅功能开着时才出现；这一版只在设了 `KINSHOKO_SUBSCRIPTIONS=1` 时有。
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

/** 订阅页占满工作区（侧栏与主区），与图片与文件夹的工作区并排切换。 */
export function SubscriptionSection({ subscriptions, safe, paneOpen, onPaneToggle, onOpenImage }: {
  subscriptions: ReturnType<typeof useSubscriptionSection>;
  safe: boolean;
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
