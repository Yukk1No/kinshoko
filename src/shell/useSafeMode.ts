import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "../i18n";
import { onSafeModeSetting, safeMode, setSafeMode } from "../ipc";
import { errorText } from "../ipc/commandError";
import { useToast } from "../ui/Toast";
import { INITIAL_SAFE_LENS, needsRecheck, reduceSafeLens, type SafeLensAction } from "./safeLens";
import { safeTiming } from "./safeTiming";

/** 主窗口的安全模式状态与切换（#60、#183），原样从 App.tsx 移出。 */
export function useSafeMode() {
  const toast = useToast();
  /**
   * 安全模式。读到设置之前按开启处理，不会先露出被封印的图。`safe` 是开关上显示的状态；
   * 查询资料库用 `lensSafe`：关闭时等后端确认才放开（#183，见 safeLens）。
   */
  const [safeState, setSafeState] = useState(INITIAL_SAFE_LENS);
  const safeStateRef = useRef(safeState);
  const applySafe = useCallback((action: SafeLensAction) => {
    safeStateRef.current = reduceSafeLens(safeStateRef.current, action);
    setSafeState(safeStateRef.current);
  }, []);
  const { shown: safe, lens: lensSafe } = safeState;
  const acceptSafe = useCallback((on: boolean) => applySafe({ kind: "external", on }), [applySafe]);
  /** 以后端保存的设置为准；读不到时按开启处理。 */
  const recheckSafe = useCallback(() => {
    safeMode().then(
      (on) => acceptSafe(on !== false),
      () => acceptSafe(true),
    );
  }, [acceptSafe]);
  const toggleSafe = useCallback(() => {
    // 不等后端：这一帧就开始遮蔽（或打开封印书）。
    applySafe({ kind: "toggle" });
    const next = safeStateRef.current.shown;
    safeTiming.toggled(next);
    setSafeMode(next).then(
      (on) => {
        safeTiming.mark("backend-confirmed");
        applySafe({ kind: "settled", on });
        // 快速连点时返回可能乱序：与最后一次点击不一致就读一次设置校准。
        if (needsRecheck(safeStateRef.current, on)) recheckSafe();
      },
      (e) => {
        applySafe({ kind: "failed" });
        toast.error(i18n.t("shell:safeMode.toggleFailed", { error: errorText(e) }));
        recheckSafe();
      },
    );
  }, [toast, applySafe, recheckSafe]);

  useEffect(() => {
    const stop = onSafeModeSetting(acceptSafe);
    return () => {
      void stop.then((stop) => stop());
    };
  }, [acceptSafe]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleSafe();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSafe]);

  return { safe, lensSafe, acceptSafe, toggleSafe };
}
