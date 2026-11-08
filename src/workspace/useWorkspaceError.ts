import { useCallback } from "react";
import { errorText, isCursorExpired } from "../ipc";
import type { ToastApi } from "../ui/Toast";
import type { Invalidate } from "./useInvalidation";

/**
 * 工作区读取期间修订变了（CursorExpired）：那次读到的结果已经过时，不是要用户处理的问题。
 * 像收到变更通知一样按新修订重读；变更停下后读取成功，不留下常驻横幅（#98）。
 * 同修订的变更通知会被略过，所以不能只等通知来补读。
 */
export function useWorkspaceError(toast: ToastApi, invalidate: Invalidate) {
  return useCallback((error: unknown) => {
    // 真实错误进轻提示（#98），一直留到画师按“知道了”；没有提示容器时退回就地横幅。
    if (!isCursorExpired(error)) { toast.error(errorText(error)); return; }
    invalidate({ kind: "cursorExpired" });
  }, [toast, invalidate]);
}
