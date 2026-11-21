import type { Ref } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import { errorText } from "../ipc";
import { SaveDestinationDialog } from "../library/SaveDestination";
import { PixivWall, type PixivWallHandle, type WallSection } from "./PixivWall";
import { useCollect } from "./useCollect";

/** 墙下方的读取状态。 */
export type WallStatus = {
  loading: boolean;
  /** 读页失败的原因。 */
  failed: unknown;
  retry: () => void;
  /** 都读完了，一张也没有。 */
  empty: boolean;
};

/**
 * 一面作品墙连同收图（#461）：已收标记、收图、第一次选保存目标、读取状态。各个去处（新作与推荐、榜单、
 * 我的收藏、画师作品）都用它，只是给的作品段不同。
 */
export function WallView({
  sections,
  safe,
  status,
  onSection,
  onNearEnd,
  onArtist,
  handle,
}: {
  sections: WallSection[];
  safe: boolean;
  status: WallStatus;
  onSection?: (key: string) => void;
  onNearEnd?: () => void;
  onArtist?: (artist: Artist) => void;
  handle?: Ref<PixivWallHandle>;
}) {
  const { t } = useTranslation("subscriptions");
  const allWorks = useMemo(() => sections.flatMap((s) => s.works), [sections]);
  const collecting = useCollect(allWorks);
  const { loading, failed, retry, empty } = status;
  return (
    <>
      <PixivWall
        sections={sections}
        safe={safe}
        collected={collecting.collected}
        busy={collecting.busy}
        onCollect={collecting.collect}
        onSection={onSection}
        onNearEnd={onNearEnd}
        onArtist={onArtist}
        handle={handle}
      />
      {collecting.notice && (
        <div className="pw-status" role="alert">
          {collecting.notice}
        </div>
      )}
      {collecting.asking && (
        <SaveDestinationDialog
          title={t("browse.chooseDestination")}
          summary={collecting.asking.work.title}
          confirmLabel={t("browse.collect")}
          initial={collecting.remembered}
          onConfirm={collecting.confirm}
          onClose={collecting.cancel}
        />
      )}
      {(loading || failed || empty) && (
        <div className="pw-status" role="status">
          {failed ? (
            <>
              <span>{t("browse.failed", { error: errorText(failed) })}</span>
              <button type="button" className="k-btn" onClick={retry}>
                {t("browse.retry")}
              </button>
            </>
          ) : loading ? (
            t("browse.loading")
          ) : (
            t("browse.empty")
          )}
        </div>
      )}
    </>
  );
}
