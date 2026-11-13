import { useEffect, useEffectEvent } from "react";
import { editable } from "../wall/wallShared";

/**
 * 图片墙上的 I 键：显示或隐藏详情面板，与查看器里的 I 同一个动作。查看器开着时由它自己响应；
 * 打字时，或对话框、菜单开着时不响应。
 */
export function useInspectorShortcut(toggle: () => void, disabled: boolean) {
  const toggleInspector = useEffectEvent(toggle);
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.toLowerCase() !== "i") return;
      if (e.defaultPrevented || editable(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      toggleInspector();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled]);
}
