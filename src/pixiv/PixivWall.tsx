import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { PixivWork } from "../bindings/PixivWork";
import { pixivImageSrc } from "../ipc/pixivBrowse";
import { CAP_RATIO, GAP, OVERSCAN, PAD, TARGET } from "../wall/wallShared";
import { pixivMasonry, visibleIn, type PixivLayout } from "./layout";
import type { CollectedPages, CollectOptions } from "./useCollect";
import { useFeedbackContext } from "./useFeedback";
import { useSubscriptionsContext } from "./useSubscriptions";
import "./pixiv.css";

/** 墙上的一段作品，例如关注的新作、推荐。段与段之间只留一点空隙，不放标题（#461 2026-11-18）。 */
export type WallSection = { key: string; works: PixivWork[] };

export type PixivWallHandle = {
  /** 滚到某一段的开头。 */
  scrollToSection: (key: string) => void;
};

type Selected = { section: string; id: string };

/** 离墙底还剩多少像素时要下一页。 */
const NEAR_END = 1200;
/** 展开的一格占视口高度的比例。 */
const BAND_SHARE = 0.72;

const NOTHING_COLLECTED: CollectedPages = new Map();
const NOTHING_BUSY: ReadonlySet<string> = new Set();

/**
 * 应用内浏览的墙（#461 第 2 步，只做骨架）：保留全图的瀑布流，只挂可见范围内的卡片；点图在墙里原地展开一格，
 * 再点大图看全图。安全模式开着时不显示 pixiv 标为 R-18 的作品。
 *
 * 收图（第 3 步）：卡片上悬停出现“收进资料库”，已收的常驻“已收”标记；展开的一格与看全图里也能收，
 * 看全图时可以只收这一页。
 */
export function PixivWall({
  sections,
  safe,
  density = TARGET,
  collected = NOTHING_COLLECTED,
  busy = NOTHING_BUSY,
  onCollect,
  onSection,
  onNearEnd,
  onArtist,
  handle,
}: {
  sections: WallSection[];
  safe: boolean;
  density?: number;
  /** 已收进资料库的页。 */
  collected?: CollectedPages;
  /** 正在收的作品。 */
  busy?: ReadonlySet<string>;
  onCollect?: (work: PixivWork, options?: CollectOptions) => void;
  /** 视口顶上是哪一段；滚动时变了才回调。 */
  onSection?: (key: string) => void;
  onNearEnd?: () => void;
  /** 展开的一格里点“查看这位画师”。不给时不显示这个按钮。 */
  onArtist?: (artist: Artist) => void;
  handle?: Ref<PixivWallHandle>;
}) {
  const { t } = useTranslation("subscriptions");
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [full, setFull] = useState<{ work: PixivWork; page: number } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = useMemo(
    () => sections.map((s) => ({ key: s.key, works: safe ? s.works.filter((w) => !w.explicit) : s.works })),
    [sections, safe],
  );
  // 选中的图被安全模式藏起来了：收起展开的一格。
  const live = selected && shown.find((s) => s.key === selected.section)?.works.some((w) => w.id === selected.id);
  const current = live ? selected : null;

  const bandHeight = Math.max(240, Math.round(size.height * BAND_SHARE));
  const placed = useMemo(() => {
    let top = 0;
    return shown.map((s) => {
      const at = current?.section === s.key ? s.works.findIndex((w) => w.id === current.id) : -1;
      const layout = pixivMasonry(
        s.works.map((w) => ({ w: Math.max(1, w.width), h: Math.max(1, w.height) })),
        { width: size.width, target: density, gap: GAP, pad: PAD, capRatio: CAP_RATIO },
        at >= 0 ? { at, height: bandHeight } : null,
      );
      const section = { ...s, top, layout };
      top += layout.height;
      return section;
    });
  }, [shown, size.width, density, current, bandHeight]);
  const total = placed.reduce((sum, s) => sum + s.layout.height, 0);

  // 视口顶上是哪一段。
  const topSection = placed.findLast((s) => s.top <= scrollTop + 1)?.key ?? placed[0]?.key;
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (topSection && topSection !== reported.current) {
      reported.current = topSection;
      onSection?.(topSection);
    }
  }, [topSection, onSection]);

  useEffect(() => {
    if (size.height && total - (scrollTop + size.height) < NEAR_END) onNearEnd?.();
  }, [scrollTop, size.height, total, onNearEnd]);

  useImperativeHandle(
    handle,
    () => ({
      scrollToSection: (key) => {
        const s = placed.find((x) => x.key === key);
        if (s && scroller.current) scroller.current.scrollTo({ top: s.top, behavior: "smooth" });
      },
    }),
    [placed],
  );

  const select = useCallback((section: string, id: string) => {
    setSelected((s) => (s?.section === section && s.id === id ? null : { section, id }));
  }, []);

  /** 在同一段里换到前一张或后一张。 */
  const step = (delta: number) => {
    if (!current) return;
    const works = shown.find((s) => s.key === current.section)?.works ?? [];
    const i = works.findIndex((w) => w.id === current.id) + delta;
    if (i >= 0 && i < works.length) setSelected({ section: current.section, id: works[i].id });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (full) return;
    if (e.key === "Escape" && current) {
      e.stopPropagation();
      setSelected(null);
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && current) {
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
    }
  };

  const bottom = scrollTop + size.height + OVERSCAN;
  return (
    <div className="pw-frame">
      <div
        ref={scroller}
        className="pw-wall"
        role="region"
        aria-label={t("browse.wall")}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="pw-canvas" style={{ height: total }}>
          {placed.map((s) =>
            visibleIn(s.layout, scrollTop - OVERSCAN - s.top, bottom - s.top).map((i) => {
              const work = s.works[i];
              const box = s.layout.boxes[i];
              return (
                <Card
                  key={`${s.key}:${work.id}`}
                  work={work}
                  style={{ left: box.x, top: s.top + box.y, width: box.w, height: box.h }}
                  on={current?.section === s.key && current.id === work.id}
                  collected={(collected.get(work.id)?.size ?? 0) > 0}
                  busy={busy.has(work.id)}
                  onClick={() => select(s.key, work.id)}
                  onCollect={onCollect && ((from) => onCollect(work, { bookmark: true, from }))}
                />
              );
            }),
          )}
          {placed.map((s) =>
            s.layout.band && current?.section === s.key ? (
              <Band
                key={`band:${s.key}`}
                layout={s.layout}
                top={s.top}
                work={s.works.find((w) => w.id === current.id)}
                collected={collected.get(current.id)}
                busy={busy.has(current.id)}
                onCollect={onCollect}
                onArtist={onArtist}
                onClose={() => setSelected(null)}
                onStep={step}
                onFull={(work) => setFull({ work, page: 0 })}
              />
            ) : null,
          )}
        </div>
      </div>
      {full && (
        <FullView
          work={full.work}
          page={full.page}
          collected={collected.get(full.work.id)?.has(full.page) ?? false}
          busy={busy.has(full.work.id)}
          onCollect={onCollect && ((from) => onCollect(full.work, { pages: [full.page], from }))}
          onPage={(page) => setFull({ ...full, page })}
          onClose={() => setFull(null)}
        />
      )}
    </div>
  );
}

function Card({
  work,
  style,
  on,
  collected,
  busy,
  onClick,
  onCollect,
}: {
  work: PixivWork;
  style: React.CSSProperties;
  on: boolean;
  collected: boolean;
  busy: boolean;
  onClick: () => void;
  onCollect?: (from: Element | null) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const src = pixivImageSrc(work.pages[0]?.preview ?? "");
  // 动图不收，不给收图按钮。
  const collectable = !!onCollect && work.kind !== "animation";
  return (
    <div className="pw-card" data-on={on || undefined} style={style}>
      <button
        type="button"
        className="pw-card-open"
        aria-pressed={on}
        aria-label={t("browse.work", { title: work.title, artist: work.artist.name })}
        onClick={onClick}
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
            onClick={(e) => onCollect?.(e.currentTarget.closest(".pw-card"))}
          >
            {t("browse.favorite")}
          </button>
        )
      )}
    </div>
  );
}

/** 在墙里原地展开的一格：左边大图，右边作品信息。 */
function Band({
  layout,
  top,
  work,
  collected,
  busy,
  onCollect,
  onArtist,
  onClose,
  onStep,
  onFull,
}: {
  layout: PixivLayout;
  top: number;
  work: PixivWork | undefined;
  collected: ReadonlySet<number> | undefined;
  busy: boolean;
  onCollect?: (work: PixivWork, options?: CollectOptions) => void;
  onArtist?: (artist: Artist) => void;
  onClose: () => void;
  onStep: (delta: number) => void;
  onFull: (work: PixivWork) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const feedback = useFeedbackContext();
  const band = layout.band;
  if (!band || !work) return null;
  const src = pixivImageSrc(work.pages[0]?.large ?? "");
  const all = (collected?.size ?? 0) >= work.pages.length;
  const collectable = !!onCollect && work.kind !== "animation";
  const bookmarked = feedback?.bookmarked(work) ?? work.bookmarked;
  const following = feedback ? (feedback.followed(work.artist.userId) ?? work.followed) : null;
  return (
    <section
      className="pw-band"
      aria-label={t("browse.work", { title: work.title, artist: work.artist.name })}
      style={{ left: band.x, top: top + band.y, width: band.w, height: band.h }}
    >
      <button type="button" className="pw-band-stage" aria-label={t("browse.viewFull")} onClick={() => onFull(work)}>
        {src && <img src={src} alt="" draggable={false} />}
      </button>
      <div className="pw-band-side">
        <h2 className="k-title">{work.title}</h2>
        <p className="pw-band-artist">
          {work.artist.name}
          {feedback && following !== null && (
            <FollowButton
              userId={work.artist.userId}
              followed={following}
              busy={feedback.followPending(work.artist.userId)}
              onToggle={() => void feedback.setFollow(work.artist, !following)}
            />
          )}
          {onArtist && (
            <button type="button" className="k-btn" onClick={() => onArtist(work.artist)}>
              {t("browse.viewArtist")}
            </button>
          )}
        </p>
        {work.pages.length > 1 && <p className="pw-band-meta">{t("browse.pages", { count: work.pages.length })}</p>}
        <ul className="pw-band-tags">
          {work.tags.slice(0, 12).map((tag) => (
            <li key={tag} className="k-token is-24 is-pill is-surface">
              {tag}
            </li>
          ))}
        </ul>
        {collectable && (
          <div className="pw-band-actions">
            {/* “收藏”一次就写 pixiv 收藏并收进资料库（#461）。都做过了才只显示“已收藏”。 */}
            {all && bookmarked ? (
              <span className="pw-band-meta">{t("browse.favorited")}</span>
            ) : (
              <button
                type="button"
                className="k-btn is-primary"
                // pixiv 收藏还在写（例如刚点了取消）时不能点：写完之前的“收藏”会只收图、不写收藏。
                disabled={busy || (feedback?.bookmarkPending(work.id) ?? false)}
                onClick={(e) => onCollect(work, { bookmark: true, from: e.currentTarget.closest(".pw-band") })}
              >
                {busy ? t("browse.collecting") : t("browse.favorite")}
              </button>
            )}
            {/* 资料库里的图被删掉了也能再收（#461）。 */}
            {all && (
              <button
                type="button"
                className="k-btn"
                disabled={busy}
                onClick={(e) => onCollect(work, { again: true, from: e.currentTarget.closest(".pw-band") })}
              >
                {t("browse.collectAgain")}
              </button>
            )}
            <button
              type="button"
              className="k-btn"
              disabled={busy}
              onClick={(e) => onCollect(work, { choose: true, from: e.currentTarget.closest(".pw-band") })}
            >
              {t("browse.collectElsewhere")}
            </button>
            {/* 取消 pixiv 收藏不动资料库里的图。 */}
            {feedback && bookmarked && (
              <button
                type="button"
                className="k-btn"
                disabled={feedback.bookmarkPending(work.id)}
                onClick={() => void feedback.setBookmark(work, false)}
              >
                {t("browse.unbookmark")}
              </button>
            )}
          </div>
        )}
        <div className="pw-band-actions">
          <a className="k-btn" href={work.pageUrl} target="_blank" rel="noreferrer">
            {t("browse.openOnPixiv")}
          </a>
          <button type="button" className="k-btn" onClick={() => onStep(-1)}>
            {t("browse.previous")}
          </button>
          <button type="button" className="k-btn" onClick={() => onStep(1)}>
            {t("browse.next")}
          </button>
          <button type="button" className="k-btn" onClick={onClose}>
            {t("browse.close")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** 看全图：盖住墙，先在作品内翻页。没收的页读 pixiv 原图，经后端转发。 */
function FullView({
  work,
  page,
  collected,
  busy,
  onCollect,
  onPage,
  onClose,
}: {
  work: PixivWork;
  page: number;
  collected: boolean;
  busy: boolean;
  onCollect?: (from: Element | null) => void;
  onPage: (page: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const current = work.pages[page];
  const src = pixivImageSrc(current?.original ?? current?.large ?? "");
  const count = work.pages.length;
  return (
    <div
      ref={ref}
      className="pw-full"
      role="group"
      aria-label={t("browse.page", { page: page + 1, count })}
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowRight" && page + 1 < count) onPage(page + 1);
        else if (e.key === "ArrowLeft" && page > 0) onPage(page - 1);
      }}
    >
      {src && <img src={src} alt="" draggable={false} />}
      {onCollect && work.kind !== "animation" && (
        <div className="pw-full-actions">
          {collected ? (
            <span className="pw-collected">{t("browse.collected")}</span>
          ) : (
            <button
              type="button"
              className="k-btn"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onCollect(e.currentTarget.closest(".pw-full"));
              }}
            >
              {busy ? t("browse.collecting") : t(count > 1 ? "browse.collectPage" : "browse.collect")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 在 pixiv 上关注这位画师。关注即订阅（#461 第 6 步）：在订阅页里关注同时订阅，已订阅时写“已关注 · 自动收”。
 * 订阅名单还没读到或不在订阅页里时只看 pixiv 的关注。
 */
export function FollowButton({
  userId,
  followed,
  busy = false,
  onToggle,
}: {
  userId: string;
  followed: boolean;
  /** 正在写：写完之前不再接受点击。 */
  busy?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const subs = useSubscriptionsContext();
  const subscribed = followed && !!subs?.artist(userId);
  // 订阅名单还没读到时不能点：取消关注时找不到订阅，就会关注取消了却还在自动收。
  // 这位画师的订阅正在退订（例如在“管理”里）时也不能点：关注会看到还没删掉的订阅而不再订阅。
  const removing = subs?.artist(userId);
  const writing =
    busy ||
    !!subs?.pending(`artist:${userId}`) ||
    (!!removing && !!subs?.pending(removing.id)) ||
    (!!subs && !subs.list);
  return (
    <button type="button" className="k-btn" aria-pressed={followed} disabled={writing} onClick={onToggle}>
      {subscribed ? t("browse.followedSubscribed") : followed ? t("browse.followed") : t("browse.follow")}
    </button>
  );
}
