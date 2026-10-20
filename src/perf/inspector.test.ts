import { afterEach, describe, expect, it } from "vitest";
import { INSPECTOR_BUDGET_MS, inspectorShows, measureSelections, summarizeSelections } from "./inspector";
import type { ProbeEnv } from "./frameProbe";

afterEach(() => { document.body.innerHTML = ""; });

/** 详情面板的样子：标明的选择、详情、有效标签；busy 表示还留着上一张的。 */
function inspector({ id = "a", busy = false, detail = true, tags = true } = {}) {
  const root = document.createElement("aside");
  root.dataset.selection = id;
  if (detail) root.insertAdjacentHTML("beforeend", `<div class="selection-detail" aria-busy="${busy}"></div>`);
  if (tags) root.insertAdjacentHTML("beforeend", `<section class="tag-panel"><ul aria-label="有效标签" aria-busy="${busy}"></ul></section>`);
  return root;
}

describe("inspectorShows：面板标明的选择、详情、标签都是这张图的才算显示完", () => {
  it("三样都到了", () => {
    expect(inspectorShows(inspector(), "a")).toBe(true);
    const panel = document.createElement("div");
    panel.append(inspector());
    expect(inspectorShows(panel, "a")).toBe(true);
  });
  it("面板标明的还是上一张，不算", () => {
    expect(inspectorShows(inspector({ id: "old" }), "a")).toBe(false);
  });
  it("详情或标签还留着上一张的、或还没有，不算", () => {
    expect(inspectorShows(inspector({ busy: true }), "a")).toBe(false);
    expect(inspectorShows(inspector({ detail: false }), "a")).toBe(false);
    expect(inspectorShows(inspector({ tags: false }), "a")).toBe(false);
  });
});

it("summarizeSelections：分位数与合格线", () => {
  const report = summarizeSelections([30, 50, 120, 40], { timedOut: 0, skipped: 1 });
  expect(report).toMatchObject({ measured: 4, p50: 40, p95: 120, max: 120, overBudget: 1, skipped: 1, budgetMs: INSPECTOR_BUDGET_MS, pass: false });
  expect(summarizeSelections([30, 50], { timedOut: 0, skipped: 0 }).pass).toBe(true);
  expect(summarizeSelections([30], { timedOut: 1, skipped: 0 }).pass).toBe(false);
});

it("measureSelections：逐张点选，记下点到详情面板显示完的时间", async () => {
  let time = 0;
  const frames: FrameRequestCallback[] = [];
  const env: ProbeEnv = {
    now: () => time,
    raf: (cb) => { frames.push(cb); return frames.length; },
    caf: () => {},
    observe: () => ({ types: [], disconnect: () => {} }),
  };
  const wall = document.createElement("div");
  const panel = document.createElement("aside");
  document.body.append(wall, panel);
  // 第一张 3 帧后显示完，第二张 7 帧后。
  const delays: Record<string, number> = { a: 3, b: 7 };
  let shownAfter = 0;
  let next: HTMLElement | null = null;
  for (const id of ["a", "b"]) {
    wall.insertAdjacentHTML("beforeend", `<div class="card" data-id="${id}"><img src="${id}.png"></div>`);
    wall.lastElementChild!.addEventListener("click", () => {
      panel.replaceChildren(inspector({ id: "old", busy: true }));
      shownAfter = delays[id];
      next = inspector({ id });
    });
  }
  const run = measureSelections({ wall, inspector: () => panel, env, settleFrames: 0 });
  // 每帧 10 ms；到点就换上新内容。
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await Promise.resolve();
    time += 10;
    if (shownAfter > 0 && --shownAfter === 0 && next) panel.replaceChildren(next);
    const pending = frames.splice(0);
    pending.forEach((cb) => cb(time));
  }
  const report = await run;
  expect(report.samples).toEqual([30, 70]);
  expect(report.pass).toBe(true);
});
