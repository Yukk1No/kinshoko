import type { ComponentProps } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import { type BrowserCard } from "../wall/Wall";
import { type WallMenuActions } from "../wall/WallMenu";
import { Viewer } from "../viewer/Viewer";
import { useViewerFlight } from "../viewer/ViewerFlight";

/**
 * 同一工作区浏览所有已登记资料库。没有“窗口打开的资料库”（ADR-0008）：资料库只来自卡片、浏览范围
 * 或画师的明确选择，后端按需切换可写句柄不影响这里的任何状态。
 */

// 工作区里的查看器层，原样从 LibraryWorkspace.tsx 移出。

type Props = {
  flight: ReturnType<typeof useViewerFlight>;
  viewing: BrowserCard | null;
  setViewing: (card: BrowserCard | null) => void;
  reloadKey: number;
  viewerPosition: { current: { index: number; total: number } | undefined };
  step: ComponentProps<typeof Viewer>["onStep"];
  viewCrop: boolean;
  inspectorOpen: boolean;
  toggleInspector: () => void;
  scope: BrowseScope;
  wallActions: WallMenuActions;
};

export function ViewerLayer({
  flight,
  viewing,
  setViewing,
  reloadKey,
  viewerPosition,
  step,
  viewCrop,
  inspectorOpen,
  toggleInspector,
  scope,
  wallActions,
}: Props) {
  return (
    <>
      {flight.card && (
        <Viewer
          key={flight.session}
          flight={flight.attr}
          hideImage={flight.hideImage}
          onPlaced={flight.onPlaced}
          libraryId={flight.card.libraryId}
          card={{ ...flight.card, id: flight.card.imageId ?? flight.card.id }}
          onClose={() => setViewing(null)}
          onBack={() => {
            flight.back();
            setViewing(null);
          }}
          reloadKey={reloadKey}
          position={viewerPosition.current}
          onStep={step}
          startCrop={viewCrop}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
          onTrash={
            !viewing ||
            (viewing.sources?.find((source) => source.libraryId === viewing.libraryId)?.deleted ??
              scope.kind === "trash")
              ? undefined
              : () => {
                  wallActions.edit([viewing], [{ kind: "delete" }], true);
                  setViewing(null);
                }
          }
        />
      )}
    </>
  );
}
