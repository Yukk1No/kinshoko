import type { KeyboardEvent } from "react";

/** 输入法正在处理这次按键（选字时的回车、Esc、方向键）。两条都要判断：个别情况下结束选字的那一下按键 isComposing 已经是假，只有 keyCode 还是 229。 */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
