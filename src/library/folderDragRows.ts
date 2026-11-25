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

export type Place = { top: number; left: number; scale: number };

/** 各行此刻在屏幕上的位置，给 {@link moveAndSettle} 用。 */
export function placesNow(nav: Element): Map<string, Place> {
  return new Map(readRows(nav).map((row) => [row.id, { top: row.top, left: row.left, scale: 1 }]));
}
