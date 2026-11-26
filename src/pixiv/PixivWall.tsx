import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type UIEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { Artist } from "../bindings/Artist";
import type { PixivWork } from "../bindings/PixivWork";
import { mountWindow, type MountWindow } from "../wall/prefetch";
import { CAP_RATIO, GAP, OVERSCAN, PAD, TARGET } from "../wall/wallShared";
import { pixivMasonry, visibleIn } from "./layout";
import { PixivWallCard as Card } from "./PixivWallCard";
import { Band, CardMenu, FullView } from "./PixivWallParts";
import type { CollectedPages, CollectOptions } from "./useCollect";

export { FollowButton } from "./FollowButton";

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
  const scrollTopRef = useRef(0);
  const mountRef = useRef<MountWindow | null>(null);
  const [mount, setMount] = useState<MountWindow>({ top: 0, bottom: 0 });
  const syncMount = useCallback((top: number, height: number) => {
    const next = mountWindow(mountRef.current, top, height, OVERSCAN);
    if (next === mountRef.current) return;
    mountRef.current = next;
    setMount(next);
  }, []);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [full, setFull] = useState<{ work: PixivWork; page: number } | null>(null);
  /** 右键菜单：哪个作品、在哪里打开。 */
  const [menu, setMenu] = useState<{ work: PixivWork; x: number; y: number } | null>(null);
  const openMenu = useCallback((work: PixivWork, x: number, y: number) => setMenu({ work, x, y }), []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      const top = el.scrollTop;
      scrollTopRef.current = top;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      syncMount(top, height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncMount]);

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

  // 展开的一格不在视口里（点的是靠底的图，或用左右键换到下一张）：滚到它刚好露出来。
  const bandAt = placed.find((s) => s.layout.band && current?.section === s.key);
  const bandTop = bandAt?.layout.band ? bandAt.top + bandAt.layout.band.y : null;
  const bandH = bandAt?.layout.band?.h ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies(current?.id): 同一行里换一张时位置不变，也要再看一次
  useEffect(() => {
    const el = scroller.current;
    if (bandTop === null || !el || !el.clientHeight) return;
    const view = el.clientHeight;
    const top = el.scrollTop;
    if (bandTop >= top && bandTop + bandH <= top + view) return;
    const target = bandTop + bandH > top + view && bandH <= view ? bandTop + bandH - view + GAP : bandTop - GAP;
    el.scrollTo?.({ top: Math.max(0, target), behavior: "smooth" });
  }, [bandTop, bandH, current?.id]);

  // 画布变矮时浏览器会先把 scrollTop 夹回去，这个变化不一定经过 scroll 事件：按真实位置同步挂载窗口。
  // biome-ignore lint/correctness/useExhaustiveDependencies(total): 画布高度变了就按真实 scrollTop 重新同步
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    scrollTopRef.current = top;
    syncMount(top, el.clientHeight);
  }, [total, syncMount]);

  // 视口顶上是哪一段，以及接近墙底时边沿触发（不逐像素重渲染）。
  const reported = useRef<string | undefined>(undefined);
  const nearEndFor = useRef<{ sections: WallSection[]; total: number } | null>(null);
  const onSectionRef = useRef(onSection);
  onSectionRef.current = onSection;
  const onNearEndRef = useRef(onNearEnd);
  onNearEndRef.current = onNearEnd;
  const latestScrollRef = useRef({ placed, total, sections });
  latestScrollRef.current = { placed, total, sections };

  const checkEdges = useCallback(
    (top: number, curPlaced: typeof placed, curTotal: number, viewportHeight: number, curSections: WallSection[]) => {
      const topSection = curPlaced.findLast((s) => s.top <= top + 1)?.key ?? curPlaced[0]?.key;
      if (topSection && topSection !== reported.current) {
        reported.current = topSection;
        onSectionRef.current?.(topSection);
      }
      if (!viewportHeight) return;
      if (curTotal - (top + viewportHeight) >= NEAR_END) {
        nearEndFor.current = null;
        return;
      }
      if (nearEndFor.current?.sections !== curSections || nearEndFor.current.total !== curTotal) {
        nearEndFor.current = { sections: curSections, total: curTotal };
        onNearEndRef.current?.();
      }
    },
    [],
  );

  useEffect(() => {
    checkEdges(scrollTopRef.current, placed, total, size.height, sections);
  }, [checkEdges, placed, total, size.height, sections]);

  const onScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const top = el.scrollTop;
      scrollTopRef.current = top;
      syncMount(top, el.clientHeight);
      const cur = latestScrollRef.current;
      checkEdges(top, cur.placed, cur.total, el.clientHeight, cur.sections);
    },
    [checkEdges, syncMount],
  );

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

  return (
    <div className="pw-frame">
      <div
        ref={scroller}
        className="pw-wall"
        role="region"
        aria-label={t("browse.wall")}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="pw-canvas" style={{ height: total }}>
          {placed.map((s) =>
            visibleIn(s.layout, mount.top - s.top, mount.bottom - s.top).map((i) => {
              const work = s.works[i];
              const box = s.layout.boxes[i];
              return (
                <Card
                  key={`${s.key}:${work.id}`}
                  sectionKey={s.key}
                  work={work}
                  left={box.x}
                  top={s.top + box.y}
                  width={box.w}
                  height={box.h}
                  on={current?.section === s.key && current.id === work.id}
                  collected={(collected.get(work.id)?.size ?? 0) > 0}
                  busy={busy.has(work.id)}
                  onSelect={select}
                  onCollect={onCollect}
                  onMenu={openMenu}
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
      {menu && (
        <CardMenu
          work={menu.work}
          point={menu}
          collected={collected.get(menu.work.id)}
          busy={busy.has(menu.work.id)}
          onCollect={onCollect}
          onArtist={onArtist}
          onClose={() => setMenu(null)}
        />
      )}
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
