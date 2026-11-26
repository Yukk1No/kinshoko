import type { HTMLAttributes, ReactNode } from "react";

export type MediaCardCorner = "topStart" | "topEnd" | "bottomStart" | "bottomEnd";

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/**
 * 媒体卡片骨架（#743）：只承担卡片底材、悬停/选中/焦点描边与四角槽位。
 * 它不管卡片在墙里的绝对定位，也不解析媒体内容；四角槽位只负责把角标与角部操作放到统一位置。
 */
export function MediaCardFrame({
  selected = false,
  stacked = false,
  layers,
  corners,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  selected?: boolean;
  /** 多页/叠纸卡片：内容层悬停微抬，`layers` 放露出的纸边。 */
  stacked?: boolean;
  layers?: ReactNode;
  corners?: Partial<Record<MediaCardCorner, ReactNode>>;
}) {
  return (
    <div
      {...props}
      className={classes("k-media-card", stacked && "is-stack", className)}
      data-selected={selected || undefined}
    >
      {stacked && layers}
      <div className="k-media-card-content">
        {children}
        {(["topStart", "topEnd", "bottomStart", "bottomEnd"] as const).map(
          (corner) =>
            corners?.[corner] && (
              <div key={corner} className={`k-media-corner is-${corner}`}>
                {corners[corner]}
              </div>
            ),
        )}
      </div>
    </div>
  );
}
