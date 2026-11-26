import { Dialog } from "@base-ui/react/dialog";
import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { X } from "lucide-react";
import { useRef, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { DialogHeight } from "./DialogHeight";

type InitialFocus = ComponentProps<typeof Dialog.Popup>["initialFocus"];

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/** 对话框底部操作区：右对齐前由调用方放 `.k-grow` 或左侧补充操作。 */
export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="k-dialog-foot">{children}</div>;
}

export type DialogPurpose = "info" | "form" | "required";

/**
 * 通用模态框外壳（#739/#743）：`purpose` 决定关闭语义。
 * info 允许 Esc 与点遮罩、默认带右上角关闭；form 不让自己点遮罩丢输入、默认不带关闭叉；required 必须明确响应。
 * 初始焦点落在对话框容器本身（不画焦点环），按 Tab 再进入内部焦点顺序；特定表单可显式覆盖。
 */
export function DialogShell({
  open,
  onOpenChange,
  purpose,
  title,
  titleClassName = "k-title",
  description,
  children,
  footer,
  className,
  closeLabel,
  showClose = purpose === "info",
  autoHeight = false,
  initialFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purpose: DialogPurpose;
  title: ReactNode;
  titleClassName?: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeLabel?: string;
  showClose?: boolean;
  autoHeight?: boolean;
  initialFocus?: InitialFocus;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const { t } = useTranslation("shell");
  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={purpose !== "info"}
      onOpenChange={(next, details) => {
        if (!next && purpose === "required" && details.reason === "escape-key") {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup ref={popup} initialFocus={initialFocus ?? popup} className={classes("k-dialog", className)}>
          {showClose && (
            <Dialog.Close className="k-icon-btn k-dialog-x" aria-label={closeLabel ?? t("dialogClose")}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          )}
          <Dialog.Title className={titleClassName}>{title}</Dialog.Title>
          {description && <Dialog.Description className="k-dialog-desc">{description}</Dialog.Description>}
          {autoHeight ? <DialogHeight>{children}</DialogHeight> : children}
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * 危险/不可撤销确认外壳（#739/#743）：没有右上角关闭，Base UI 的 AlertDialog 禁止点遮罩；
 * Esc 仍可取消。初始焦点必须由 `cancelRef` 落在“取消”按钮，不能落到危险主按钮。
 */
export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  cancelRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  cancelRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className="k-backdrop" />
        <BaseAlertDialog.Popup initialFocus={cancelRef} className={classes("k-dialog", "is-alert", className)}>
          <BaseAlertDialog.Title className="k-title">{title}</BaseAlertDialog.Title>
          {description && (
            <BaseAlertDialog.Description className="k-dialog-desc">{description}</BaseAlertDialog.Description>
          )}
          {children}
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
