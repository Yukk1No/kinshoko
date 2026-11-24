import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { Keys } from "./Keys";

/** 悬停提示统一的等待时间：同一组提示之间移动时不再等。 */
export const TIP_DELAY = 500;

/** 每个窗口挂一次：提示共用等待时间，从一个提示移到下一个时立刻显示。 */
export function TipProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delay={TIP_DELAY}>{children}</Tooltip.Provider>;
}

/**
 * 悬停提示（Base UI Tooltip，`.k-tip`）：只给名称或补全被截断的文字，不是唯一的说明，控件仍要有自己的 aria-label。
 * 取代原生 `title`：原生提示画在网页外面，键盘聚焦看不到，样式也不属于设计系统。
 * `keys` 是快捷键，排在名称后面，用键帽显示。`label` 为空时不弹。`focus={false}`：聚焦时不弹（这一行聚焦时已经把说明显示出来了）。
 */
export function Tip({
  label,
  keys,
  children,
  side = "bottom",
  align = "center",
  focus = true,
  ...trigger
}: {
  label: ReactNode;
  keys?: string;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  focus?: boolean;
} & Omit<Tooltip.Trigger.Props, "render" | "children">) {
  // 别的触发器（菜单、小确认）把它当 render 时，传进来的属性与 ref 交给 Tooltip.Trigger，再落到 children 上。
  const empty = label === undefined || label === null || label === false || label === "";
  return (
    <Tooltip.Root
      disabled={empty}
      onOpenChange={(open, details) => {
        if (open && !focus && details.reason === "trigger-focus") details.cancel();
      }}
    >
      <Tooltip.Trigger {...trigger} render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="k-positioner" side={side} align={align} sideOffset={8}>
          <Tooltip.Popup className="k-tip">
            {keys ? (
              <span className="k-tip-line">
                {label}
                <Keys accelerator={keys} />
              </span>
            ) : (
              label
            )}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
