import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SelectionBar } from "../library/SelectionBar";
import { arcSpring } from "../ui/motion";
import { useReducedMotion } from "../ui/reducedMotion";
import { DensityIsland } from "./DensityIsland";
import { densityMorphRises, selectionBarCompact, selectionBarPlacement } from "./selectionBarPlacement";
import { noticeAnchor, rowTopOf } from "./noticeAnchor";

/** 折叠后的圆形按钮宽度。 */
const KNOB = 40;
/** 圆形按钮形变成滑条后的宽度（宽窗口下的值，窄窗口下实际更窄，只会更早改为向上）。 */
const SLIDER = 214;
/** 向上展开时升起的高度：越过悬浮栏（高 56 px）再隔开 8 px，与 main-window.css 的 --density-rise 相同。 */
const RISE = 64;

/**
 * 浮在图片墙上的两样东西（#180）：底部的多选悬浮栏，和右下角那一组（打标图标在图片大小浮岛左边）。
 * 悬浮栏出现时右下角像灵动岛一样收成一个圆形按钮让位；悬浮栏按 selectionBarPlacement 避开它，
 * 实在放不下时圆形按钮暂时隐藏。三者同时用 Dock 的形变弹簧，减少动画时直接到位。
 * 圆形按钮形变为滑条时（#452）悬浮栏不动，滑条按 densityMorphRises 避开它。
 * 放在图片墙所在的定位容器里，宽度量的就是这个容器。
 */
export function WallFloats({
  bar,
  tagging,
  density,
}: {
  /** 多选悬浮栏；null 时不显示（单选、没有选择、查看器打开时）。 */
  bar: Omit<ComponentProps<typeof SelectionBar>, "left" | "onWidth"> | null;
  /** 打标图标；collapsed 时换成圆形按钮上的小圆点。 */
  tagging: (collapsed: boolean) => ReactNode;
  /** 图片大小浮岛；null 时不显示（查看器打开时）。 */
  density: Omit<ComponentProps<typeof DensityIsland>, "collapsed"> | null;
}) {
  const reduced = useReducedMotion();
  const corner = useRef<HTMLDivElement>(null);
  const [wallWidth, setWallWidth] = useState(0);
  const [cornerRight, setCornerRight] = useState(24);
  // 完整与紧凑两种悬浮栏各自量到的宽度。
  const [widths, setWidths] = useState({ full: 0, compact: 0 });
  const [rising, setRising] = useState(false);
  useLayoutEffect(() => {
    const host = corner.current?.parentElement;
    if (!host) return;
    const measure = () => {
      setWallWidth(host.clientWidth);
      // 右边距随容器查询变化（窄时 16 px）。
      if (corner.current) setCornerRight(parseFloat(getComputedStyle(corner.current).right) || 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useNoticeAnchor(corner, { rising, bar: bar !== null, viewer: density === null });

  const collapsed = bar !== null;
  const compact = selectionBarCompact(wallWidth, widths.full);
  const barWidth = compact ? widths.compact : widths.full;
  const onWidth = (width: number, compactBar: boolean) =>
    setWidths((w) => (compactBar ? { ...w, compact: width } : { ...w, full: width }));
  const cornerLeft = wallWidth - cornerRight - KNOB;
  const place = selectionBarPlacement({ wallWidth, barWidth, cornerLeft });
  const hideCorner = collapsed && wallWidth > 0 && barWidth > 0 && place.hideCorner;
  const rise = densityMorphRises({ barRight: place.left + barWidth, cornerLeft, grow: SLIDER - KNOB });
  const morph = reduced ? { duration: 0 } : arcSpring.morph;
  return (
    <>
      <motion.div
        ref={corner}
        className="k-wall-corner"
        data-collapsed={collapsed || undefined}
        aria-hidden={hideCorner || undefined}
        inert={hideCorner}
        animate={{ opacity: hideCorner ? 0 : 1, scale: hideCorner ? 0.6 : 1 }}
        transition={morph}
      >
        <motion.div className="k-wall-badge" initial={false} animate={{ y: rising ? -RISE : 0 }} transition={morph}>
          {tagging(collapsed)}
        </motion.div>
        {density && <DensityIsland {...density} collapsed={collapsed} rise={rise} onRising={setRising} />}
      </motion.div>
      <AnimatePresence>
        {bar && <SelectionBar key="selbar" {...bar} left={place.left} compact={compact} onWidth={onWidth} />}
      </AnimatePresence>
    </>
  );
}

/** 通知停靠的位置写到根元素上（--k-notice-right、--k-notice-bottom、--k-notice-max），toast.css 与导入任务卡按它定位。 */
const NOTICE_VARS = ["--k-notice-right", "--k-notice-bottom", "--k-notice-max"] as const;

/**
 * 量出通知该停在哪（#609，规则见 noticeAnchor）：图片墙区域、右下角那一组、多选悬浮栏、查看器工具条
 * 变了就重量。卸载时（离开图库工作区）去掉，通知回到窗口右下角。
 */
function useNoticeAnchor(
  corner: React.RefObject<HTMLDivElement | null>,
  { rising, bar, viewer }: { rising: boolean; bar: boolean; viewer: boolean },
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies(bar): 悬浮栏出现或收起时重量（它不在这个组件的 DOM 引用里，按选择器找）
  // biome-ignore lint/correctness/useExhaustiveDependencies(viewer): 查看器开合时重量（工具条在查看器里，按选择器找）
  useLayoutEffect(() => {
    const own = corner.current;
    const host = own?.parentElement;
    if (!own || !host) return;
    const root = document.documentElement.style;
    const measure = () => {
      const rows = [rowTopOf(own, rising ? RISE : 0)];
      for (const selector of [".selbar-float", ".viewer-dock"]) {
        const element = host.querySelector<HTMLElement>(selector);
        if (element)
          rows.push(
            selector === ".viewer-dock"
              ? host.getBoundingClientRect().bottom - element.getBoundingClientRect().top
              : rowTopOf(element),
          );
      }
      const box = host.getBoundingClientRect();
      // 图片墙藏起来时（切到订阅页等）通知回到窗口右下角。
      if (box.width === 0) {
        for (const name of NOTICE_VARS) root.removeProperty(name);
        return;
      }
      const anchor = noticeAnchor({
        host: box,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        inset: Number.parseFloat(getComputedStyle(own).right) || 0,
        rowTop: Math.max(...rows),
      });
      root.setProperty("--k-notice-right", `${anchor.right}px`);
      root.setProperty("--k-notice-bottom", `${anchor.bottom}px`);
      root.setProperty("--k-notice-max", `${anchor.maxWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const selector of [".selbar-float", ".viewer-dock"]) {
      const element = host.querySelector(selector);
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [corner, rising, bar, viewer]);
  useLayoutEffect(
    () => () => {
      for (const name of NOTICE_VARS) document.documentElement.style.removeProperty(name);
    },
    [],
  );
}
