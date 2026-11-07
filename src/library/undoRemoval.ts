import type { LibraryInfo } from "../bindings/LibraryInfo";
import { registerLibrary, switchLibrary } from "../ipc";
import type { ToastApi } from "../ui/Toast";

/**
 * 从列表移除图库只取消本设备的登记，文件原样保留，所以直接移除，再给“撤销”轻提示。
 * 未连接的图库没法重新登记，不给撤销。
 */
export function offerUndoRemoval(toast: ToastApi | null, library: { name: string; root: string }, restore: (root: string) => Promise<void>, onError: (message: string) => void) {
  toast?.show({
    title: "已从列表移除", description: library.name, tone: "success",
    action: { label: "撤销", onClick: () => { restore(library.root).catch((error) => onError(String(error))); } },
  });
}

/** 重新登记 `root`。登记会同时打开它；移除前另有当前图库（`keep`）时切回那个图库，撤销不改动当前图库。 */
export async function reRegister(root: string, keep: string | null | undefined): Promise<LibraryInfo> {
  const info = await registerLibrary(root);
  return keep && keep !== info.id ? switchLibrary(keep) : info;
}
