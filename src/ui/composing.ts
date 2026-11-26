import type { KeyboardEvent } from "react";
import { isImeComposing } from "../keymap/KeymapRegistry";

/** React 按键事件的 IME 守卫；唯一实现留在 KeymapRegistry。 */
export function isComposingKey(event: KeyboardEvent): boolean {
  return isImeComposing(event.nativeEvent);
}
