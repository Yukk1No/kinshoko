// #158：从点选一张参考图到详情面板把详情与标签都显示出来的时间（合格线 100 ms，沿用验收约定里
// “约 100 ms 内出现操作反馈”）。详情面板里的预览图已删除（#179）。
//
// 驱动方式：逐张点击图片墙里的卡片（与画师单击选中同一条路），每帧检查详情面板，直到它标明整理的是这张
// （data-selection），详情与标签也都不再留着上一张的（aria-busy）。时间从点击到满足条件的那一帧为止，
// 精度是一帧。只量主窗口的“选中一张”：多来源整理（.workspace-sources）要再点一次“整理此来源”，跳过。

import { browserEnv, type ProbeEnv } from "./frameProbe";

export const INSPECTOR_BUDGET_MS = 100;

export type InspectorReport = {
  /** 每次点选到显示完的毫秒数，按点选顺序。 */
  samples: number[];
  measured: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  overBudget: number;
  /** 超时（timeoutMs 内没显示完）的点选。 */
  timedOut: number;
  /** 没有缩略图或走多来源整理而跳过的卡片。 */
  skipped: number;
  budgetMs: number;
  pass: boolean;
};

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;

export function summarizeSelections(samples: number[], { timedOut, skipped }: { timedOut: number; skipped: number }): InspectorReport {
  const sorted = [...samples].sort((a, b) => a - b);
  const overBudget = sorted.filter((ms) => ms > INSPECTOR_BUDGET_MS).length;
  return {
    samples,
    measured: samples.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    overBudget,
    timedOut,
    skipped,
    budgetMs: INSPECTOR_BUDGET_MS,
    pass: samples.length > 0 && overBudget === 0 && timedOut === 0,
  };
}

const busy = (el: Element | null) => !el || el.getAttribute("aria-busy") === "true";

/** 详情面板正在显示 id 这张图：面板标明的选择就是它，详情与有效标签都已是新读到的。 */
export function inspectorShows(inspector: ParentNode, id: string): boolean {
  const marker = inspector instanceof Element && inspector.hasAttribute("data-selection") ? inspector : inspector.querySelector("[data-selection]");
  if (marker?.getAttribute("data-selection") !== id) return false;
  return !busy(inspector.querySelector(".selection-detail")) && !busy(inspector.querySelector('.tag-panel [aria-label="有效标签"]'));
}

const nextFrame = (env: ProbeEnv) => new Promise<number>((resolve) => env.raf(resolve));

export type SelectionOptions = {
  wall: HTMLElement;
  inspector: () => Element | null;
  /** 最多点选几张（从图片墙里按顺序取）。 */
  count?: number;
  timeoutMs?: number;
  /** 两次点选之间空出的帧数，让上一张的收尾不算进下一张。 */
  settleFrames?: number;
  env?: ProbeEnv;
};

export async function measureSelections({ wall, inspector, count = 20, timeoutMs = 2000, settleFrames = 10, env = browserEnv() }: SelectionOptions): Promise<InspectorReport> {
  const samples: number[] = [];
  let timedOut = 0;
  let skipped = 0;
  for (const card of [...wall.querySelectorAll<HTMLElement>(".card")].slice(0, count)) {
    const id = card.dataset.id;
    if (!id) { skipped++; continue; }
    const start = env.now();
    card.click();
    for (;;) {
      await nextFrame(env);
      const box = inspector();
      if (box?.querySelector(".workspace-sources")) { skipped++; break; }
      if (box && inspectorShows(box, id)) {
        samples.push(env.now() - start);
        break;
      }
      if (env.now() - start > timeoutMs) { timedOut++; break; }
    }
    for (let i = 0; i < settleFrames; i++) await nextFrame(env);
  }
  return summarizeSelections(samples, { timedOut, skipped });
}
