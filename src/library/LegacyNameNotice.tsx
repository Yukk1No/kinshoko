import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { logFailure } from "../runLog";
import { SettingsGroup, SettingsRow } from "../ui/SettingsList";
import { NOTICE_ORDER, usePersistentToast } from "../ui/Toast";
import { useLegacyNamesPlan } from "./tagCatalogMirrors";

// 旧名称待确认的提示条与设置入口，原样从 LegacyNameMigrationPanel.tsx 移出。

/**
 * 读取共享镜像里的名称来源待处理计划。读取出错时数量按 0，不弹错误 toast；
 * 记一条运行日志，排查时知道通知为什么没出现（#433）。
 */
function useLegacyNameCount() {
  const plan = useLegacyNamesPlan();
  const logged = useRef<unknown>(null);
  useEffect(() => {
    if (plan.error === null) {
      logged.current = null;
      return;
    }
    if (logged.current === plan.error) return;
    logged.current = plan.error;
    logFailure("plan legacy names", plan.error);
  }, [plan.error]);
  return {
    count: plan.error !== null ? 0 : (plan.value?.plan.groups.length ?? 0),
    settled: !plan.refreshing && (plan.value !== null || plan.error !== null),
  };
}

/**
 * 主窗口的旧名称通知（#433）：关掉后只有待确认数量超过关掉时的数量才再弹，所以切换安全模式不会打扰。
 * 重读期间沿用上次的数量，切换安全模式时通知不闪。
 */
export function LegacyNameMigrationNotice(props: {
  safe: boolean;
  enabled: boolean;
  hidden: boolean;
  onOpen: () => void;
}) {
  const { enabled, hidden, onOpen } = props;
  const { t } = useTranslation("legacyNames", { keyPrefix: "notice" });
  const { count, settled } = useLegacyNameCount();
  const pending = useRef(0);
  if (settled) pending.current = count;
  usePersistentToast(
    enabled && pending.current > 0
      ? { title: t("title", { count: pending.current }), action: { label: t("open"), onClick: onOpen } }
      : null,
    { hidden, level: pending.current, queue: NOTICE_ORDER.legacyNames },
  );
  return null;
}

/** 设置 › 标签 › 显示名底部：通知关掉后从这里进向导。 */
export function LegacyNameEntry({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation("legacyNames");
  const { count: pending } = useLegacyNameCount();
  if (pending === 0 || !onOpen) return null;
  return (
    <SettingsGroup label={t("entry.title")}>
      <SettingsRow
        icon={<Sparkles size={16} />}
        title={t("entry.title")}
        hint={t("entry.hint")}
        warn={<span role="status">{t("notice.title", { count: pending })}</span>}
      >
        <button type="button" className="k-btn is-sm" onClick={onOpen}>
          <span className="k-label">{t("notice.open")}</span>
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}
