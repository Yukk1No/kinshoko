import type { HTMLAttributes, ReactNode } from "react";

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * 页面骨架（#743）：侧栏插槽、56 px 顶栏、可选 48 px 次栏与工作面。
 * 它只排骨架，不拥有页面语义；调用方仍决定外层是不是 `main`、侧栏与详情栏的内容。
 */
export function PageFrame({
  sidebar,
  endbar,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  sidebar?: ReactNode;
  endbar?: ReactNode;
}) {
  return (
    <div {...props} className={classes("k-page-frame", className)}>
      {sidebar}
      <div className="k-page-body">{children}</div>
      {endbar}
    </div>
  );
}

export function PageTopbar({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <header {...props} className={classes("k-page-topbar", className)} data-tauri-drag-region>
      {children}
    </header>
  );
}

export function PageSubbar({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={classes("k-page-subbar", className)}>
      {children}
    </div>
  );
}

export function PageSurface({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={classes("k-page-surface", className)}>
      {children}
    </div>
  );
}
