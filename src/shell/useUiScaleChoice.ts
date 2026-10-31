import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "../i18n";
import { setUiScale, uiScale } from "../ipc";
import type { useToast } from "../ui/Toast";
import { initialUiScale, stepUiScale, uiScaleStepForKey } from "./uiScale";

/** 主窗口的界面缩放（#173），从 App 搬出来。 */
export function useUiScaleChoice(toast: ReturnType<typeof useToast>) {
  /**
   * 界面缩放档位（#173）。WebView 由核心缩放，这里只记下档位给图片墙和设置用：
   * 显示的档位在核心保存并缩放之后才换；连按时从最后按下的那一档往下数。
   * 写入一次只发一个：上一个完成后若又按了别的档，再写最后按到的那一档，旧的写入不会盖过新的。
   */
  const [uiScalePercent, setUiScalePercent] = useState(initialUiScale);
  const uiScaleTarget = useRef(uiScalePercent);
  const uiScaleSaved = useRef(uiScalePercent);
  const uiScaleWriting = useRef(false);
  const acceptUiScale = useCallback((saved: number) => {
    uiScaleSaved.current = saved;
    uiScaleTarget.current = saved;
    setUiScalePercent(saved);
  }, []);
  const chooseUiScale = useCallback(async (percent: number) => {
    if (percent === uiScaleTarget.current) return;
    uiScaleTarget.current = percent;
    if (uiScaleWriting.current) return;
    uiScaleWriting.current = true;
    try {
      while (uiScaleTarget.current !== uiScaleSaved.current) {
        const wanted = uiScaleTarget.current;
        try {
          const saved = await setUiScale(wanted);
          uiScaleSaved.current = saved;
          if (uiScaleTarget.current === wanted) acceptUiScale(saved);
        } catch (e) {
          toast?.error(i18n.t("shell:uiScaleFailed", { error: String(e) }));
          acceptUiScale(await uiScale().catch(() => uiScaleSaved.current));
        }
      }
    } finally {
      uiScaleWriting.current = false;
    }
  }, [toast, acceptUiScale]);

  // 界面缩放的固定按键；Ctrl+滚轮不在这里，它归图片墙的图片大小（#111）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = uiScaleStepForKey(e);
      if (!step) return;
      e.preventDefault();
      void chooseUiScale(stepUiScale(uiScaleTarget.current, step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseUiScale]);
  return { uiScalePercent, uiScaleWriting, acceptUiScale, chooseUiScale };
}
