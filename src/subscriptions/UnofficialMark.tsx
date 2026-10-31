import { useTranslation } from "react-i18next";

/** “非官方”标记（#366）：订阅页标题、首次使用说明与设置 › 订阅都带着它。 */
export function UnofficialMark() {
  const { t } = useTranslation("subscriptions");
  return <span className="subs-unofficial" title={t("unofficialTip")}>{t("unofficial")}</span>;
}
