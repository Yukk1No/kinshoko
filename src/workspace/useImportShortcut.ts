import { useEffect, type RefObject } from "react";
import type { ImportControl } from "../library/import/ImportCenter";

/**
 * 导入菜单里“图片”的快捷键 Ctrl O：与菜单项同一入口，导入进行中时由入口自己忽略。
 * 设置、分组编辑器等对话框或菜单开着时不响应，免得导入流程叠在它们上面。
 */
export function useImportShortcut(importControl: RefObject<ImportControl | null>, hidden: boolean) {
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "o") return;
      if (e.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      importControl.current?.files();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, importControl]);
}
