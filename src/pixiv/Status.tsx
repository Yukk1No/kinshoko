import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errorText } from "../ipc";
import { EmptyState } from "../ui/EmptyState";

/**
 * 应用内浏览里一处列表的读取状态（#461 第 7 步）：读取中是转圈加一句话，读失败是错误字加“重试”，
 * 读完了一个也没有用列表的空状态。三种都是 `role="status"`，读屏会报出来。
 */
export function PixivStatus({
  loading = false,
  failed,
  retry,
  empty,
}: {
  loading?: boolean;
  failed?: unknown;
  retry?: () => void;
  /** 空的时候说的话；不给就是不空。 */
  empty?: string | null;
}) {
  const { t } = useTranslation("subscriptions");
  if (failed != null && failed !== false)
    return (
      <div className="pw-status" role="status">
        <span className="k-error-text">{t("browse.failed", { error: errorText(failed) })}</span>
        {retry && (
          <button type="button" className="k-btn is-sm" onClick={retry}>
            {t("browse.retry")}
          </button>
        )}
      </div>
    );
  if (loading)
    return (
      <div className="pw-status" role="status">
        <LoaderCircle className="k-spinner" size={14} aria-hidden="true" />
        <span>{t("browse.loading")}</span>
      </div>
    );
  if (empty) return <EmptyState size="list" role="status" className="pw-empty" title={empty} />;
  return null;
}
