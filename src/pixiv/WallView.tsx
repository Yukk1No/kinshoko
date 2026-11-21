import type { Ref } from "react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import { errorText } from "../ipc";
import { SaveDestinationDialog } from "../library/SaveDestination";
import { PixivWall, type PixivWallHandle, type WallSection } from "./PixivWall";
import type { Collecting } from "./useCollect";

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
 * 一面作品墙连同已收标记、收图与读取状态（#461）。各个去处（新作与推荐、榜单、我的收藏、画师作品）都用它，
 * 只是给的作品段不同；收图状态整页共用一份，提示与保存目标对话框见 `CollectPrompts`。
 */
export function WallView({
  sections,
  safe,
  collecting,
  status,
  onSection,
  onNearEnd,
  onArtist,
  handle,
}: {
  sections: WallSection[];
  safe: boolean;
  /** 订阅页共用的一份（`useCollect`）。 */
  collecting: Collecting;
  status: WallStatus;
  onSection?: (key: string) => void;
  onNearEnd?: () => void;
  onArtist?: (artist: Artist) => void;
  handle?: Ref<PixivWallHandle>;
}) {
  const { t } = useTranslation("subscriptions");
  const allWorks = useMemo(() => sections.flatMap((s) => s.works), [sections]);
  const { track } = collecting;
  useEffect(() => track(allWorks), [allWorks, track]);
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

/** 收图的提示与第一次选保存目标的对话框，整页只放一份。 */
export function CollectPrompts({ collecting }: { collecting: Collecting }) {
  const { t } = useTranslation("subscriptions");
  return (
    <>
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
    </>
  );
}
