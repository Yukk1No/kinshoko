import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  as?: "div" | "li";
  role?: "status";
  className?: string;
} & (
  | { size: "page"; icon: ReactNode; hint?: ReactNode; actions?: ReactNode; headingAs?: "h1" | "h2" }
  | { size: "list"; icon?: never; hint?: never; actions?: never; headingAs?: never }
);

export function EmptyState({ as: Root = "div", className = "", role, title, ...props }: Props) {
  if (props.size === "list") {
    return (
      <Root className={`k-empty is-list ${className}`.trim()} role={role}>
        {title}
      </Root>
    );
  }
  const Heading = props.headingAs ?? "h2";
  return (
    <Root className={`k-empty is-page ${className}`.trim()} role={role}>
      <span className="k-empty-icon" aria-hidden="true">
        {props.icon}
      </span>
      <Heading className="k-title">{title}</Heading>
      {props.hint && props.hint !== title && <p className="k-empty-hint">{props.hint}</p>}
      {props.actions && <div className="k-empty-actions">{props.actions}</div>}
    </Root>
  );
}
