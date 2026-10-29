import { useSyncExternalStore } from "react";

/** 启动加载页（#338）最多挡这么久：到时间即使首屏缩略图没到齐也进入主界面，没到的在图片墙里接着补。 */
export const STARTUP_TIMEOUT_MS = 5000;
/** 首屏：图片墙第一页的前这么多张缩略图，与运行日志的“第 20 张缩略图显示”同一口径。 */
export const FIRST_SCREEN = 20;

export type StartupGate = {
  /** 0–1：资料库打开、第一页到达、缩略图逐张到达。 */
  progress: number;
  /** 可以进入主界面了。放行后不再收回。 */
  released: boolean;
};

let opened = false;
let target: number | null = null;
let shown = 0;
let state: StartupGate = { progress: 0.08, released: false };
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: StartupGate) {
  if (next.progress === state.progress && next.released === state.released) return;
  state = next;
  for (const listener of listeners) listener();
}

function update() {
  if (state.released) return;
  if (target !== null && shown >= target) return publish({ progress: 1, released: true });
  const progress = target === null ? (opened ? 0.4 : 0.08) : 0.5 + (0.5 * shown) / target;
  publish({ progress, released: false });
}

/** 上次的资料库打开了（加载页的第一段）。 */
export function startupLibraryOpened(): void {
  opened = true;
  update();
}

/** 图片墙第一页到了：首屏要等的缩略图数是这一页的前 {@link FIRST_SCREEN} 张，空墙直接放行。 */
export function startupWallPage(cards: number): void {
  if (target !== null) return;
  opened = true;
  target = Math.min(FIRST_SCREEN, Math.max(0, cards));
  update();
}

/** 图片墙一张缩略图显示了。 */
export function startupThumbnailShown(): void {
  shown += 1;
  update();
}

/** 不再等首屏：打不开资料库、没有图片墙可等，或超时。 */
export function releaseStartup(): void {
  if (!state.released) publish({ progress: 1, released: true });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 超时从页面开始加载算起，与运行日志的首屏计时同一起点。
  if (!timer && !state.released) timer = setTimeout(releaseStartup, Math.max(0, STARTUP_TIMEOUT_MS - performance.now()));
  return () => { listeners.delete(listener); };
}

/** 加载页的进度与是否放行。 */
export function useStartupGate(): StartupGate {
  return useSyncExternalStore(subscribe, () => state);
}

/** 测试用：回到页面刚加载时。 */
export function resetStartupGate(): void {
  opened = false;
  target = null;
  shown = 0;
  state = { progress: 0.08, released: false };
  if (timer) clearTimeout(timer);
  timer = null;
}
