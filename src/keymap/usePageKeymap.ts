import { useEffect, useEffectEvent } from "react";
import { type KeymapAction, keymapRegistry } from "./registry";

/**
 * 在窗口层接入一组页面内快捷键。命中注册表时统一 `preventDefault`，再交给调用方；
 * `when` 每次按键时现查，适合“对话框或菜单开着时不响应”这类瞬态条件。
 */
export function usePageKeymap<Action extends KeymapAction>(
  actions: readonly Action[],
  onAction: (action: Action, event: KeyboardEvent) => void,
  { disabled = false, when }: { disabled?: boolean; when?: () => boolean } = {},
) {
  const runAction = useEffectEvent(onAction);
  const allowed = useEffectEvent(() => when?.() !== false);
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!allowed()) return;
      for (const action of actions) {
        if (!keymapRegistry.matches(action, event)) continue;
        event.preventDefault();
        runAction(action, event);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, actions]);
}
