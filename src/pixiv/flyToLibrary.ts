import { animate } from "motion/react";
import { arcSpring } from "../ui/motion";
import { reducedNow } from "../ui/reducedMotion";

/** 图标轨上“图片与文件夹”的按钮：收进来的图飞向它（#461、#448）。 */
const TARGET = '.rail [data-section="browse"]';
/** 落到图标上时的边长：比图标小一圈，像一张缩小的图掉进去。 */
const LANDING = 16;
/** 落地前淡出用的时长（秒）。 */
const FADE = 0.12;

/**
 * 收进图库成功后，从卡片（或展开的一格、全图）上拿一张缩略图飞向图标轨上的图库图标（#461 第 7 步）。
 * 动效只表现位置、大小与可见性的变化，不碰图片像素（design/ui-system/visual-and-motion.md「图片」）。
 * 系统减弱动效、找不到起点或图标（例如图标轨没挂上）时什么都不做；收图本身不受影响。
 */
export function flyToLibrary(from: Element | null | undefined): void {
  if (!from || reducedNow()) return;
  const image = from instanceof HTMLImageElement ? from : from.querySelector("img");
  const target = document.querySelector(TARGET);
  const src = image?.currentSrc || image?.src;
  if (!image || !src || !target) return;
  const a = image.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (!a.width || !a.height || !b.width) return;

  const flier = document.createElement("img");
  flier.className = "pw-flier";
  flier.src = src;
  flier.alt = "";
  Object.assign(flier.style, {
    left: `${a.left}px`,
    top: `${a.top}px`,
    width: `${a.width}px`,
    height: `${a.height}px`,
  });
  // 借主墙封印影子的那一层（`.fx-layer`）：固定铺满窗口、不接指针，层级在墙、查看器与图标轨之上。
  const layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.append(flier);
  document.body.append(layer);

  const scale = LANDING / Math.max(a.width, a.height);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  // 位置与大小走弹簧；快落到图标上时才淡出，像掉进去，而不是半路消失。
  animate(
    flier,
    { x: dx, y: dy, scale, opacity: 0 },
    { ...arcSpring.morph, opacity: { duration: FADE, delay: arcSpring.morph.visualDuration - FADE } },
  ).finished.then(
    () => layer.remove(),
    () => layer.remove(),
  );
}
