import type { ReactNode } from "react";

/**
 * 设置与对话框里的一行（design/ui-system/README.md「设置」）：图标 · 名称 · 一句描述 · 右侧控件。
 * `label` 给整行一个无障碍名称（例如快捷键行按动作名查找）。
 */
export function SettingsRow({ icon, title, desc, warn, children, label, className = "", below }: {
  icon?: ReactNode; title: ReactNode; desc?: ReactNode; warn?: ReactNode; children?: ReactNode; label?: string; className?: string;
  /** 行下方展开的内容（例如预览、确认、编辑器），与这一行同属一项。 */
  below?: ReactNode;
}) {
  return <li className={`k-list-row k-set-row ${className}`} aria-label={label}>
    <div className="k-set-row-main">
      {icon && <span className="k-list-icon" aria-hidden="true">{icon}</span>}
      <div className="k-list-text">
        <div className="k-list-title">{title}</div>
        {desc && <p className="k-list-desc">{desc}</p>}
        {warn && <p className="k-list-desc is-warn">{warn}</p>}
      </div>
      {children !== undefined && <div className="k-list-end">{children}</div>}
    </div>
    {below && <div className="k-set-row-below">{below}</div>}
  </li>;
}

/** 一组行；`title` 是组标题（如“图库”“偏好设置”）。 */
export function SettingsGroup({ title, label, children }: { title?: string; label?: string; children: ReactNode }) {
  return <>
    {title && <h4 className="k-set-group">{title}</h4>}
    <ul className="k-list k-set-list" aria-label={label ?? title}>{children}</ul>
  </>;
}

/** 状态徽标：成功（绿）、注意（黄）或普通。 */
export function StatusPill({ tone = "plain", children }: { tone?: "ok" | "warn" | "plain" | "accent" | "mine"; children: ReactNode }) {
  return <span className={`k-pill${tone === "plain" ? "" : ` is-${tone}`}`}>{children}</span>;
}
