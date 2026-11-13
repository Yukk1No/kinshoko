import type { ComponentProps, Dispatch, SetStateAction } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { WallFloats } from "../wall/WallFloats";
import type { WallMenuActions } from "../wall/WallMenu";
import type { useWorkspaceInspector } from "./useWorkspaceInspector";

// 图片墙右下角多选悬浮栏的入参，原样从 LibraryWorkspace.tsx 移出。

type Inspector = ReturnType<typeof useWorkspaceInspector>;

export function wallFloatBar({ inspected, hidden, viewerOpen, selectionLibrary, panelIds, scope, setSelected, reloadKey, onError, safe, selectedCards, wallActions }: {
  inspected: Inspector["inspected"]; hidden: boolean; viewerOpen: boolean; selectionLibrary: Inspector["selectionLibrary"]; panelIds: Inspector["panelIds"];
  scope: BrowseScope; setSelected: Dispatch<SetStateAction<Set<string>>>; reloadKey: number; onError: (error: unknown) => void; safe: boolean;
  selectedCards: Inspector["selectedCards"]; wallActions: WallMenuActions;
}): ComponentProps<typeof WallFloats>["bar"] {
  return inspected !== null || hidden || viewerOpen ? null
              : selectionLibrary !== null ? (panelIds.length > 1 ? {
                libraryId: selectionLibrary, scope, ids: panelIds, onClear: () => setSelected(new Set()), reloadKey, onError, safeMode: safe,
              } : null)
              : selectedCards.length > 1 ? {
                libraryId: null, scope, ids: selectedCards.map((card) => card.id), onClear: () => setSelected(new Set()), reloadKey, onError, safeMode: safe,
                acrossLibraries: {
                  folderLibrary: new Set(selectedCards.map((card) => card.libraryId)).size === 1 ? selectedCards[0].libraryId ?? null : null,
                  edit: (edits, clear) => wallActions.edit(selectedCards, edits, clear),
                },
              } : null;
}
