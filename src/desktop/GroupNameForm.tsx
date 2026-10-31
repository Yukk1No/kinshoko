import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * 起名与改名（设计系统 TextField“配按钮”）：上方一行字段名与关闭按钮，下面输入框与“保存”并排，
 * 同高 32、间距 8。Enter 保存，Esc 或关闭按钮取消。
 */
export function GroupNameForm({ title, label, placeholder, value, onChange, onSubmit, onCancel, busy = false, blocked = false, primary = true, className = "" }: {
  title: string; label: string; placeholder?: string; value: string; onChange: (value: string) => void;
  onSubmit: () => void; onCancel: () => void;
  /** 正在保存：输入框与按钮都不能用。 */
  busy?: boolean;
  /** 暂时不能保存（另一次保存还没结束）。 */
  blocked?: boolean;
  /** “保存”用 ink 实底：只给侧栏里本屏的主操作（起名），卡片里的改名用普通按钮。 */
  primary?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("desktop", { keyPrefix: "nameForm" });
  return <form className={`group-name-form ${className}`} onSubmit={(e) => { e.preventDefault(); if (value.trim() && !busy && !blocked) onSubmit(); }}
    onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
    <div className="group-name-head">
      <span className="k-field-label">{title}</span>
      <button type="button" className="k-icon-btn is-sm" aria-label={t("cancel")} title={t("cancelTitle")} disabled={busy} onClick={onCancel}><X size={14} aria-hidden="true" /></button>
    </div>
    <div className="k-field-row">
      <input className="k-input" aria-label={label} placeholder={placeholder} autoFocus disabled={busy}
        value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="submit" className={`k-btn${primary ? " is-primary" : ""}`} disabled={!value.trim() || busy || blocked}><span className="k-label">{t("save")}</span></button>
    </div>
  </form>;
}
