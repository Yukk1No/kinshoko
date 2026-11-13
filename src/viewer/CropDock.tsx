import type { Region } from "../bindings/Region";
import { type CssRect } from "./crop";
import { Pin, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dock } from "../ui/Dock";
import { Tip } from "../ui/Tip";
import { FollowDock } from "../ui/FollowDock";
import { OriginalStar } from "../ui/OriginalStar";
import { DOCK_RESERVE } from "./ViewerParts";

// 框选后跟随选区的 dock，原样从 Viewer.tsx 移出。

type Props = {
  shownCropRect: CssRect;
  crop: Region;
  viewport: { width: number; height: number; left: number; top: number; dpr: number };
  cropTool: (id: string) => void;
};

export function CropDock({ shownCropRect, crop, viewport, cropTool }: Props) {
  const { t } = useTranslation(["viewer", "common"]);
  return (
    <FollowDock anchor={shownCropRect} bounds={viewport} reserveBottom={DOCK_RESERVE}>
      <Dock
        label={t("crop.label")}
        onSelect={cropTool}
        readout={
          <Tip label={t("originalPixels")} side="top">
            <span className="k-original">
              {crop.width} × {crop.height}
              <span className="sr-only">{t("originalPixels")}</span>
              <OriginalStar />
            </span>
          </Tip>
        }
        items={[
          {
            id: "pin",
            label: t("common:image.pinPart"),
            icon: <Pin size={18} strokeWidth={1.9} />,
            shortcut: "Enter",
            tone: "primary",
          },
          { id: "redo", label: t("crop.redo"), icon: <RotateCcw size={18} strokeWidth={1.75} /> },
          {
            id: "cancel",
            label: t("crop.cancel"),
            icon: <X size={18} strokeWidth={1.75} />,
            shortcut: "Esc",
            tone: "danger",
          },
        ]}
      />
    </FollowDock>
  );
}
