import { useTranslation } from "react-i18next";
import { WarnIcon } from "../ui/WarnIcon";

/** “非官方”标记（#366）：订阅页标题、首次使用说明与设置 › 订阅都带着它。 */
export function UnofficialMark() {
  const { t } = useTranslation("subscriptions");
  return (
    <span className="subs-unofficial">
      <WarnIcon />
      {t("unofficial")}
    </span>
  );
}
