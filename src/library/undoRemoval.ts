import type { ToastApi } from "../ui/Toast";
import { i18n } from "../i18n";
import { errorText } from "../ipc/commandError";

/**
 * 从列表移除图库只取消本设备的登记，文件原样保留，所以直接移除，再给“撤销”轻提示。
 * 未连接的图库没法重新登记，不给撤销。
 */
export function offerUndoRemoval(toast: ToastApi | null, library: { name: string; root: string }, restore: (root: string) => Promise<void>, onError: (message: string) => void) {
  toast?.show({
    title: i18n.t("library:libraryMenu.removed"), description: library.name, tone: "success",
    action: { label: i18n.t("library:libraryMenu.undo"), onClick: () => { restore(library.root).catch((error) => onError(errorText(error))); } },
  });
}

