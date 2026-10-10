/**
 * 真正的模态：明确声明 aria-modal 的（查看器）、提醒对话框，以及 Base UI 打开着的对话框（`.k-dialog`）。
 * 行内浮层也用 role="dialog"（查找框的相近标签、别名编辑），它们不挡住背后的界面，不算。
 */
const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"], .k-dialog[role="dialog"][data-open]';

export function modalOpen(root: ParentNode = document): boolean {
  return root.querySelector(MODAL) !== null;
}
