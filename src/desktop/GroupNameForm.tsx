import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tip } from "../ui/Tip";

/**
 * 参考组卡片里的改名（设计系统 TextField“配按钮”）：上方一行字段名与关闭按钮，下面输入框与“保存”
 * 并排，同高 32、间距 8。Enter 保存，Esc 或关闭按钮取消。
 */
export function GroupNameForm({
  title,
  label,
  value,
  onChange,
  onSubmit,
  onCancel,
  busy = false,
}: {
  title: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** 正在保存：输入框与按钮都不能用。 */
  busy?: boolean;
}) {
  const { t } = useTranslation("desktop", { keyPrefix: "nameForm" });
  return (
    <form
      className="group-name-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && !busy) onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="group-name-head">
        <span className="k-field-label">{title}</span>
        <Tip label={t("cancel")} keys="Esc">
          <button
            type="button"
            className="k-icon-btn is-sm"
            aria-label={t("cancel")}
            disabled={busy}
            onClick={onCancel}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </Tip>
      </div>
      <div className="k-field-row">
        <input
          className="k-input"
          aria-label={label}
          autoFocus
          disabled={busy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button type="submit" className="k-btn" disabled={!value.trim() || busy}>
          <span className="k-label">{t("save")}</span>
        </button>
      </div>
    </form>
  );
}
