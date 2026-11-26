import { usePageKeymap } from "../keymap/usePageKeymap";

const INSPECTOR_KEYS = ["main.toggleInspector"] as const;
const dialogsOpen = () => !document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');

/**
 * 图片墙上的 I 键：显示或隐藏详情面板，与查看器里的 I 同一个动作。查看器开着时由它自己响应；
 * 打字时，或对话框、菜单开着时不响应。
 */
export function useInspectorShortcut(toggle: () => void, disabled: boolean) {
  usePageKeymap(INSPECTOR_KEYS, () => toggle(), { disabled, when: dialogsOpen });
}
