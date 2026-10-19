import { createContext, useContext } from "react";

/**
 * 界面缩放（#173）：主窗口的 WebView 按档位整体缩放，叠加在系统 DPI 缩放之上；100% 为跟随系统。
 * 档位与核心的 `UI_SCALE_LEVELS` 相同，核心拒绝其他值。
 */
export const UI_SCALE_LEVELS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_UI_SCALE = 100;

declare global {
  interface Window {
    /** 核心建主窗口时写入的档位，让首帧的图片墙就按它排（#173）。 */
    __KINSHOKO_UI_SCALE__?: number;
  }
}

/** 页面启动时的档位：核心预先写入的值；没有或不是现有档位时为 100%。之后以 `ui_scale` 命令为准。 */
export function initialUiScale(): number {
  const seeded = typeof window === "undefined" ? undefined : window.__KINSHOKO_UI_SCALE__;
  return (UI_SCALE_LEVELS as readonly number[]).includes(seeded ?? NaN) ? seeded! : DEFAULT_UI_SCALE;
}

export type UiScaleStep = "in" | "out" | "reset";

/** Ctrl+= 放大一档、Ctrl+- 缩小一档、Ctrl+0 复位；到头后不再变化。 */
export function stepUiScale(current: number, step: UiScaleStep): number {
  if (step === "reset") return DEFAULT_UI_SCALE;
  const levels: readonly number[] = UI_SCALE_LEVELS;
  const index = levels.indexOf(current);
  if (index < 0) return DEFAULT_UI_SCALE;
  return levels[Math.max(0, Math.min(levels.length - 1, index + (step === "in" ? 1 : -1)))];
}

/**
 * 主窗口按键对应的缩放动作：Ctrl+=（含 Ctrl++）、Ctrl+-、Ctrl+0，小键盘的 + - 0 同样有效。
 * 按字符判断，日文键盘上要按 Shift 才打得出的 = 也认。其余按键为 null。
 */
export function uiScaleStepForKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key">): UiScaleStep | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  switch (e.key) {
    case "=": case "+": return "in";
    case "-": return "out";
    case "0": return "reset";
    default: return null;
  }
}

/**
 * 当前界面缩放的倍数（100% 为 1）。图片墙用它把卡片保持在原来的屏幕尺寸：
 * CSS 像素随界面缩放变大，卡片的 CSS 宽度就按同一倍数缩小。
 */
export const UiScaleContext = createContext(1);

export function useUiScale(): number {
  return useContext(UiScaleContext);
}
