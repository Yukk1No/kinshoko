import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Feed } from "../bindings/Feed";
import { errorText } from "../ipc";
import { Segmented } from "../ui/Segmented";
import { PixivWall, type PixivWallHandle, type WallSection } from "./PixivWall";
import { usePixivFeed } from "./usePixivFeed";
import "./pixiv.css";

const FOLLOWING: Feed = { kind: "following" };
const RECOMMENDED: Feed = { kind: "recommended" };
/**
 * 新作读几页：关注的新作是一条很长的流，这一段只放最近的一页，看完往下就是推荐。
 * “精选新作”怎么挑还没定（#461），定了以后换掉这一条。
 */
const FOLLOWING_PAGES = 1;

type Tab = "following" | "recommended";

/**
 * 订阅页的主区（#461 第 2 步，骨架）：墙占满，先新作后推荐，标题行的去处跟着滚动走。
 * 还没挂到应用里：最后一个 PR 换掉现有订阅页时才露出来。榜单、我的收藏、画师、搜索在后面的 PR 加。
 */
export function PixivHome({ safe }: { safe: boolean }) {
  const { t } = useTranslation("subscriptions");
  const following = usePixivFeed(FOLLOWING, FOLLOWING_PAGES);
  // 新作读完（或读不了）再读推荐，免得两条流同时排队。
  const recommended = usePixivFeed(following.done || following.error ? RECOMMENDED : null);
  const [tab, setTab] = useState<Tab>("following");
  const wall = useRef<PixivWallHandle>(null);

  const sections = useMemo<WallSection[]>(() => {
    // 推荐里偶尔有新作里已经出现的作品，只留新作里那一份。
    const seen = new Set(following.works.map((w) => w.id));
    return [
      { key: "following", works: following.works },
      { key: "recommended", works: recommended.works.filter((w) => !seen.has(w.id)) },
    ];
  }, [following.works, recommended.works]);
  const onSection = useCallback((key: string) => setTab(key as Tab), []);
  const { more } = recommended;
  const onNearEnd = useCallback(() => more(), [more]);

  const failed = following.error ?? recommended.error;
  const retry = following.error ? following.retry : recommended.retry;
  const loading = following.loading || recommended.loading;
  const empty = !loading && !failed && following.done && recommended.done && sections.every((s) => !s.works.length);

  return (
    <div className="pw-page">
      <div className="pw-tabs">
        <Segmented<Tab>
          label={t("browse.tabs")}
          value={tab}
          onChange={(key) => {
            setTab(key);
            wall.current?.scrollToSection(key);
          }}
          options={[
            { value: "following", label: t("browse.following") },
            { value: "recommended", label: t("browse.recommended") },
          ]}
        />
      </div>
      <PixivWall sections={sections} safe={safe} onSection={onSection} onNearEnd={onNearEnd} handle={wall} />
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
    </div>
  );
}
