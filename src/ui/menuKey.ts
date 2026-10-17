/** 菜单键或 Shift+F10：用键盘打开右键菜单。 */
export const isMenuKey = (e: Pick<KeyboardEvent, "key" | "shiftKey">) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** 在元素中心派发一次 contextmenu，键盘打开的菜单与右键走同一路径。 */
export function openMenuAt(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  node.dispatchEvent(new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
}
