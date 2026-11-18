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
import type { PixivWork } from "../bindings/PixivWork";
import { pixivImageSrc } from "../ipc/pixivBrowse";
import { CAP_RATIO, GAP, OVERSCAN, PAD, TARGET } from "../wall/wallShared";
import { pixivMasonry, visibleIn, type PixivLayout } from "./layout";
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

/**
 * 应用内浏览的墙（#461 第 2 步，只做骨架）：保留全图的瀑布流，只挂可见范围内的卡片；点图在墙里原地展开一格，
 * 再点大图看全图。安全模式开着时不显示 pixiv 标为 R-18 的作品。
 */
export function PixivWall({
  sections,
  safe,
  density = TARGET,
  onSection,
  onNearEnd,
  handle,
}: {
  sections: WallSection[];
  safe: boolean;
  density?: number;
  /** 视口顶上是哪一段；滚动时变了才回调。 */
  onSection?: (key: string) => void;
  onNearEnd?: () => void;
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
                  onClick={() => select(s.key, work.id)}
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
  onClick,
}: {
  work: PixivWork;
  style: React.CSSProperties;
  on: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("subscriptions");
  const src = pixivImageSrc(work.pages[0]?.preview ?? "");
  return (
    <button
      type="button"
      className="pw-card"
      data-on={on || undefined}
      aria-pressed={on}
      aria-label={t("browse.work", { title: work.title, artist: work.artist.name })}
      style={style}
      onClick={onClick}
    >
      {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
      {work.pages.length > 1 && <span className="pw-pages">{t("browse.pages", { count: work.pages.length })}</span>}
    </button>
  );
}

/** 在墙里原地展开的一格：左边大图，右边作品信息。 */
function Band({
  layout,
  top,
  work,
  onClose,
  onStep,
  onFull,
}: {
  layout: PixivLayout;
  top: number;
  work: PixivWork | undefined;
  onClose: () => void;
  onStep: (delta: number) => void;
  onFull: (work: PixivWork) => void;
}) {
  const { t } = useTranslation("subscriptions");
  const band = layout.band;
  if (!band || !work) return null;
  const src = pixivImageSrc(work.pages[0]?.large ?? "");
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
        <h2 className="pw-band-title">{work.title}</h2>
        <p className="pw-band-artist">{work.artist.name}</p>
        {work.pages.length > 1 && <p className="pw-band-meta">{t("browse.pages", { count: work.pages.length })}</p>}
        <ul className="pw-band-tags">
          {work.tags.slice(0, 12).map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
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
  onPage,
  onClose,
}: {
  work: PixivWork;
  page: number;
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
    </div>
  );
}
