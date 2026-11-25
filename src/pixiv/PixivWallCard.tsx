import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { PixivWork } from "../bindings/PixivWork";
import { pixivImageSrc } from "../ipc/pixivBrowse";
import type { CollectOptions } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";

export const PixivWallCard = memo(function PixivWallCard({
  sectionKey,
  work,
  left,
  top,
  width,
  height,
  on,
  collected,
  busy,
  onSelect,
  onCollect,
}: {
  sectionKey: string;
  work: PixivWork;
  left: number;
  top: number;
  width: number;
  height: number;
  on: boolean;
  collected: boolean;
  busy: boolean;
  onSelect: (section: string, id: string) => void;
  onCollect?: (work: PixivWork, options?: CollectOptions) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const src = pixivImageSrc(work.pages[0]?.preview ?? "");
  // 动图不收，不给收图按钮。
  const collectable = !!onCollect && work.kind !== "animation";
  return (
    <div className="pw-card" data-on={on || undefined} style={{ left, top, width, height }}>
      <button
        type="button"
        className="pw-card-open"
        aria-pressed={on}
        aria-label={t("browse.work", { title: work.title, artist: work.artist.name })}
        onClick={() => onSelect(sectionKey, work.id)}
      >
        {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
      </button>
      {work.pages.length > 1 && <span className="pw-pages">{t("browse.pages", { count: work.pages.length })}</span>}
      {collected ? (
        <span className="pw-collected">{t("browse.collected")}</span>
      ) : busy ? (
        <span className="pw-collected">{t("browse.collecting")}</span>
      ) : (
        collectable && (
          <button
            type="button"
            className="pw-collect k-btn"
            aria-label={t("browse.favoriteWork", { title: work.title })}
            disabled={feedback?.bookmarkPending(work.id) ?? false}
            onClick={(e) => onCollect?.(work, { bookmark: true, from: e.currentTarget.closest(".pw-card") })}
          >
            {t("browse.favorite")}
          </button>
        )
      )}
    </div>
  );
});
