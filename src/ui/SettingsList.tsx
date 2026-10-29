import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 设置与对话框里的一行（设计系统 SettingsList）：图标、名称、右侧控件，没有描述行。
 * `hint` 是名称说不清时的补充：鼠标悬停整行时是提示；键盘聚焦到这一行的控件时显示在名称下方，
 * 并经 `aria-describedby` 读给读屏软件。`meta` 是这一项的当前状态（版本、进度、位置），
 * 用 `ink-2` 小字放在控件左边；`warn` 是需要用户处理的问题，仍在名称下方占一行。
 * 设置项改动即生效，不加“保存”按钮。`label` 给整行一个无障碍名称（例如快捷键行按动作名查找）。
 */
export function SettingsRow({ icon, title, hint, meta, warn, children, label, className = "", below }: {
  icon?: ReactNode; title: ReactNode; hint?: string; meta?: ReactNode; warn?: ReactNode; children?: ReactNode; label?: string; className?: string;
  /** 行下方展开的内容（例如预览、确认、编辑器），与这一行同属一项。 */
  below?: ReactNode;
}) {
  const hintId = useId();
  const row = useRef<HTMLLIElement>(null);
  // 行下方的内容出现时展开、消失时收起（#310）：收起的过渡里仍画着上一次的内容，收完再卸掉。
  const belowOpen = below !== undefined && below !== null && below !== false;
  const lastBelow = useRef<ReactNode>(null);
  const belowArea = useRef<HTMLDivElement>(null);
  const [, setBelowCleared] = useState(0);
  if (belowOpen) lastBelow.current = below;
  const clearBelow = () => { lastBelow.current = null; setBelowCleared((n) => n + 1); };
  // 没有过渡可等（减弱动效时时长为 0，不会有 transitionend）就立刻卸掉。
  useLayoutEffect(() => {
    if (belowOpen || lastBelow.current === null || !belowArea.current) return;
    const durations = getComputedStyle(belowArea.current).transitionDuration.split(",").map((d) => parseFloat(d) || 0);
    if (Math.max(0, ...durations) === 0) clearBelow();
  }, [belowOpen]);
  // 控件由调用方给出（开关、下拉、按钮，或行下方的文件输入与按钮）：把补充说明挂到这一行的每个控件上。
  useLayoutEffect(() => {
    if (!hint) return;
    const controls = row.current?.querySelectorAll<HTMLElement>(":is(.k-set-row-main .k-list-end, .k-set-row-below) :is(button, input, select, textarea, [role='switch'], [tabindex])") ?? [];
    for (const control of controls) {
      const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      if (!ids.includes(hintId)) control.setAttribute("aria-describedby", [...ids, hintId].join(" "));
    }
  });
  return <li ref={row} className={`k-list-row k-set-row ${className}`} aria-label={label} title={hint}>
    <div className="k-set-row-main">
      {icon && <span className="k-list-icon" aria-hidden="true">{icon}</span>}
      <div className="k-list-text">
        <div className="k-list-title">{title}</div>
        {hint && <p id={hintId} className="k-set-hint">{hint}</p>}
        {warn && <p className="k-list-desc is-warn">{warn}</p>}
      </div>
      {(meta !== undefined || children !== undefined) && <div className="k-list-end">
        {meta !== undefined && <span className="k-list-meta">{meta}</span>}
        {children}
      </div>}
    </div>
    {(belowOpen || lastBelow.current !== null) && <div ref={belowArea} className="k-set-row-below" data-open={belowOpen ? "" : undefined} inert={!belowOpen}
      onTransitionEnd={(e) => { if (!belowOpen && e.target === e.currentTarget) clearBelow(); }}>
      <div className="k-set-row-below-clip"><div className="k-set-row-below-body">{belowOpen ? below : lastBelow.current}</div></div>
    </div>}
  </li>;
}

/**
 * 一组行（#310）：浅槽托盘里放一张卡，组与组靠托盘分开，不写看得见的组名。`label` 是这组的无障碍名称；
 * `note` 是说明这一整组的小字，放在卡片下方、仍在托盘里，和它说明的行算同一组。
 */
export function SettingsGroup({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return <div className="k-set-group">
    <ul className="k-list k-set-list" aria-label={label}>{children}</ul>
    {note && <p className="k-set-note">{note}</p>}
  </div>;
}

/** 状态胶囊：完成（绿）、注意（黄）或普通；胶囊里必须有文字，图标放在文字前。 */
export function StatusPill({ tone = "plain", icon, children }: { tone?: "ok" | "warn" | "plain" | "accent" | "mine"; icon?: ReactNode; children: ReactNode }) {
  return <span className={`k-pill${tone === "plain" ? "" : ` is-${tone}`}`}>{icon}<span className="k-label">{children}</span></span>;
}
