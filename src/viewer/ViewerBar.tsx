import { ArrowLeft, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format";
import { Tip } from "../ui/Tip";

// 查看器顶栏（返回、标题、序号、缩放），原样从 Viewer.tsx 移出。

type Props = {
  name: string | null;
  position?: { index: number; total: number };
  onBack: () => void;
  onStep?: (delta: -1 | 1) => void;
  zoomAt: (factor: number) => void;
  physicalWidth: number;
  card: { width: number };
};

export function ViewerBar({ name, position, onBack, onStep, zoomAt, physicalWidth, card }: Props) {
  const { t } = useTranslation(["viewer", "common"]);
  return (
    <header className="viewer-bar">
      <button type="button" className="k-btn is-quiet viewer-back" aria-label={t("backLabel")} onClick={onBack}>
        <ArrowLeft size={16} />
        <span className="k-label">{t("back")}</span>
      </button>
      <Tip label={name}>
        <span className="viewer-title">{name}</span>
      </Tip>
      {position && (
        <>
          <span className="viewer-index">
            {formatNumber(position.index + 1)} / {formatNumber(position.total)}
          </span>
          <Tip label={t("previous")} keys="←">
            <button
              type="button"
              className="k-icon-btn"
              aria-label={t("previous")}
              disabled={position.index <= 0}
              onClick={() => onStep?.(-1)}
            >
              <ChevronLeft size={16} />
            </button>
          </Tip>
          <Tip label={t("next")} keys="→">
            <button
              type="button"
              className="k-icon-btn"
              aria-label={t("next")}
              disabled={position.index >= position.total - 1}
              onClick={() => onStep?.(1)}
            >
              <ChevronRight size={16} />
            </button>
          </Tip>
        </>
      )}
      <span className="k-grow" />
      <div className="viewer-zoom">
        <Tip label={t("zoomOut")}>
          <button type="button" className="k-icon-btn" aria-label={t("zoomOut")} onClick={() => zoomAt(0.8)}>
            <Minus size={15} />
          </button>
        </Tip>
        <output aria-label={t("zoomLevel")}>{Math.round((physicalWidth / card.width) * 100)}%</output>
        <Tip label={t("zoomIn")}>
          <button type="button" className="k-icon-btn" aria-label={t("zoomIn")} onClick={() => zoomAt(1.25)}>
            <Plus size={15} />
          </button>
        </Tip>
      </div>
    </header>
  );
}
