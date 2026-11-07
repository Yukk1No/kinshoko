import { useRef, type ReactElement, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";

/**
 * 贴在按钮旁的小确认（Base UI Popover，外观同 `.k-popup`）：一句写明什么回不来，取消在前、确认在后。
 * 只用于单个、就地的不可撤销操作；能撤销的直接做再给“撤销”轻提示，影响一批东西的用提醒对话框。
 * 打开时焦点落在“取消”上。`open` / `onOpenChange` 可选，由调用方在别处（例如按 Esc 关对话框时）打开它。
 */
export function Popconfirm({ children, description, confirm, onConfirm, open, onOpenChange, side = "bottom", align = "end" }: {
  /** 触发它的按钮。 */
  children: ReactElement;
  description: ReactNode;
  confirm: string;
  onConfirm: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Popover.Root open={open} onOpenChange={(next) => onOpenChange?.(next)}>
    <Popover.Trigger render={children} />
    <Popover.Portal>
      <Popover.Positioner className="k-positioner" side={side} align={align} sideOffset={6}>
        <Popover.Popup className="k-popup k-popconfirm" initialFocus={cancel}>
          <Popover.Description className="k-popconfirm-desc">{description}</Popover.Description>
          <div className="k-popconfirm-acts">
            <Popover.Close ref={cancel} className="k-btn is-sm"><span className="k-label">取消</span></Popover.Close>
            <Popover.Close className="k-btn is-sm is-danger" onClick={onConfirm}><span className="k-label">{confirm}</span></Popover.Close>
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
