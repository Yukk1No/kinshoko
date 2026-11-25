// 文件夹行在 DOM 里的读法：拖动会话与落定动画共用这一份测量。
import type { DragRow } from "./folderMove";

const folderButtons = (nav: Element) =>
  [...nav.querySelectorAll<HTMLButtonElement>("button[data-folder-id]")].filter((button) => !button.closest("[inert]"));

export type Row = DragRow & { el: HTMLElement; button: HTMLButtonElement; left: number; width: number };

export function readRows(nav: Element): Row[] {
  return folderButtons(nav).map((button) => {
    const el = (button.closest(".k-fluid-row") as HTMLElement | null) ?? button;
    const rect = el.getBoundingClientRect();
    return {
      id: button.dataset.folderId as string,
      depth: Number(button.dataset.depth ?? 0),
      parent: button.dataset.parentFolder || null,
      el,
      button,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  });
}
