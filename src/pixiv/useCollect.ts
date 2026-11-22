import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CollectedWork } from "../bindings/CollectedWork";
import type { PixivWork } from "../bindings/PixivWork";
import type { SaveDestination } from "../bindings/SaveDestination";
import { errorText } from "../ipc";
import { subscriptionCollect, subscriptionCollected } from "../ipc/pixivBrowse";
import { destinationAvailable, useSaveDestination } from "../library/SaveDestination";
import { flyToLibrary } from "./flyToLibrary";
import type { Feedback } from "./useFeedback";

/** 作品 id → 已收进（任一个）资料库的页。 */
export type CollectedPages = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * 收图的方式。`pages` 为空时收全部页；`choose` 时先选保存目标；`again` 时已收的页也再收一次；
 * `bookmark` 时同时在 pixiv 收藏（#461 第 5 步：“收藏”是一个动作）。`from` 是点下去的那张卡（或展开的一格、
 * 全图），收好后从它飞一张缩略图到图标轨上的图库图标（#448）。
 */
export type CollectOptions = {
  pages?: number[] | null;
  choose?: boolean;
  again?: boolean;
  bookmark?: boolean;
  from?: Element | null;
};

const NO_WORKS: PixivWork[] = [];

type Asking = { work: PixivWork; options: CollectOptions };

function merge(map: CollectedPages, ids: string[], rows: CollectedWork[]): Map<string, Set<number>> {
  const next = new Map(map as Map<string, Set<number>>);
  for (const id of ids) next.delete(id);
  for (const row of rows) {
    const pages = next.get(row.workId) ?? new Set<number>();
    for (const page of row.pages) pages.add(page);
    next.set(row.workId, pages);
  }
  return next;
}

/**
 * 应用内浏览的收图（#461 第 3 步）：墙上作品的“已收”标记，以及把作品收进资料库。保存目标用这个入口
 * 上次亲手选的；第一次使用、记住的目标不在了或画师要换地方时先让画师选（`asking`）。
 */
export function useCollect(works: PixivWork[] = NO_WORKS, feedback: Feedback | null = null) {
  const { t } = useTranslation("subscriptions");
  const save = useSaveDestination();
  const [collected, setCollected] = useState<CollectedPages>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const asked = useRef(new Set<string>());

  const refresh = useCallback((ids: string[]) => {
    for (const id of ids) asked.current.add(id);
    return subscriptionCollected(ids).then(
      (rows) => setCollected((map) => merge(map, ids, rows)),
      () => {
        // 读不到标记时下次再问；不挡浏览。
        for (const id of ids) asked.current.delete(id);
      },
    );
  }, []);

  /** 读这些作品的“已收”标记；问过的不再问。几面墙共用一份时，各自把自己的作品交进来。 */
  const track = useCallback(
    (list: PixivWork[]) => {
      const fresh = list.map((w) => w.id).filter((id) => !asked.current.has(id));
      if (fresh.length) void refresh(fresh);
    },
    [refresh],
  );

  useEffect(() => track(works), [works, track]);

  const run = useCallback(
    async (work: PixivWork, destination: SaveDestination, options: CollectOptions) => {
      setBusy((s) => new Set(s).add(work.id));
      setNotice(null);
      // 选定了保存目标才写 pixiv 收藏：在对话框里取消时两样都不做。写失败另有说明，图照收。
      if (options.bookmark && feedback && !feedback.bookmarked(work)) await feedback.setBookmark(work, true);
      try {
        // 换了地方收（choose）时已收的页也再收一次：同一个资料库里字节相同的图只合并来源，并放进新选的文件夹。
        const again = (options.again ?? false) || (options.choose ?? false);
        const report = await subscriptionCollect(work, destination, options.pages ?? null, again);
        if (report.skipped) setNotice(t("browse.animationSkipped"));
        else if (report.failed) setNotice(t("browse.collectPartly", { count: report.failed }));
        if (!report.skipped && report.collected > 0) flyToLibrary(options.from);
      } catch (error) {
        setNotice(t("browse.collectFailed", { error: errorText(error) }));
      } finally {
        setBusy((s) => {
          const next = new Set(s);
          next.delete(work.id);
          return next;
        });
        await refresh([work.id]);
      }
    },
    [refresh, t, feedback],
  );

  const collect = useCallback(
    (work: PixivWork, options: CollectOptions = {}) => {
      const remembered = save.memory.pixivDestination;
      if (!options.choose && save.ready && remembered && destinationAvailable(remembered, save.providers)) {
        void run(work, remembered, options);
      } else {
        setAsking({ work, options });
      }
    },
    [run, save.memory.pixivDestination, save.ready, save.providers],
  );

  /** 画师在保存目标对话框里选定了：记住它，再收。 */
  const confirm = useCallback(
    (destination: SaveDestination) => {
      if (!asking) return Promise.resolve();
      save.rememberPixiv(destination);
      return run(asking.work, destination, asking.options);
    },
    [asking, run, save],
  );

  return {
    track,
    collected,
    busy,
    notice,
    collect,
    asking,
    confirm,
    cancel: () => setAsking(null),
    remembered: save.memory.pixivDestination,
  };
}

/** 订阅页上几面墙共用的收图状态：一面墙里收了，别的墙上的同一个作品也立刻标成已收。 */
export type Collecting = ReturnType<typeof useCollect>;
