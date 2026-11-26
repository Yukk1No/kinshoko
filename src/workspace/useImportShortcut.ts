import type { RefObject } from "react";
import type { ImportControl } from "../library/ImportMenu";
import { usePageKeymap } from "../keymap/usePageKeymap";

const IMPORT_KEYS = ["main.importImages"] as const;
const dialogsOpen = () => !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');

/**
 * 导入菜单里“图片”的快捷键 Ctrl O：与菜单项同一入口，导入进行中时由入口自己忽略。
 * 设置、分组编辑器等对话框或菜单开着时不响应，免得导入流程叠在它们上面。
 */
export function useImportShortcut(importControl: RefObject<ImportControl | null>, hidden: boolean) {
  usePageKeymap(IMPORT_KEYS, () => importControl.current?.files(), { disabled: hidden, when: dialogsOpen });
}
