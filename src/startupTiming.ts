import { invoke } from "@tauri-apps/api/core";
import { startupThumbnailShown } from "./startupGate";

/** 首屏的几个时刻（#313），与后端 `StartupStep` 一一对应。 */
export type StartupStep = "scriptStarted" | "libraryOpened" | "wallFirstPage" | "firstThumbnail" | "twentyThumbnails";

const marked = new Set<StartupStep>();
let thumbnails = 0;

/**
 * 记下首屏的一个时刻进运行日志：从窗口开始加载页面算起的毫秒数。每个时刻每次加载只记第一次。
 */
export function markStartup(step: StartupStep): void {
  if (marked.has(step)) return;
  marked.add(step);
  void invoke("log_timing", { step, ms: Math.round(performance.now()) }).catch(() => {});
}

/** 图片墙一张缩略图加载完：第 1 张和第 20 张记进运行日志；启动加载页按它放行（#338）。 */
export function markThumbnailShown(): void {
  thumbnails += 1;
  startupThumbnailShown();
  if (thumbnails === 1) markStartup("firstThumbnail");
  if (thumbnails === 20) markStartup("twentyThumbnails");
}
