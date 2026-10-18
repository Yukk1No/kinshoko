// #123：视口内卡片从“连续可见区间开始”到“正式缩略图加载并解码完成”的时间（#102 故事 19：≤100 ms）。
//
// 每张卡片每进入一次视口就开一个区间：进入时 img 已加载（浏览器缓存命中）的，等 decode() 完成再记
// （通常接近 0，计为缓存命中）；其余 load 并 decode() 完成后记完成延迟；完成前离开视口或被卸载的区间
// 单独计数，不混入完成延迟的分位数。
// 观察会给每张卡片挂 IntersectionObserver 并在 load 后调用 decode()，与帧时间测量分开跑。

export const REPLACEMENT_BUDGET_MS = 100;

export type ReplacementReport = {
  /** 已完成的可见区间数（含缓存命中记 0 的）。 */
  completed: number;
  /** 其中进入视口时已解码（缓存命中）的。 */
  instant: number;
  /** 已完成区间里超过门槛的个数。 */
  overBudget: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  /** 完成前离开视口（或卸载）的区间：可见时长超过门槛的个数与总数。 */
  abandoned: number;
  abandonedOverBudget: number;
  /** 结束时仍可见且未完成的区间。 */
  pendingAtEnd: number;
  pendingAtEndOverBudget: number;
  budgetMs: number;
  /** 每个已完成区间都在门槛内，且没有离开时或结束时仍未完成、已超门槛的区间，才通过。 */
  pass: boolean;
};

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;

/** 由各区间的结果汇总；纯函数。 */
export function summarizeReplacement(
  intervals: { latency?: number; abandonedAfter?: number; pendingFor?: number; instant?: boolean }[],
  budgetMs = REPLACEMENT_BUDGET_MS,
): ReplacementReport {
  const done = intervals.filter((i) => i.latency !== undefined).map((i) => i.latency!).sort((a, b) => a - b);
  const abandoned = intervals.filter((i) => i.abandonedAfter !== undefined);
  const pending = intervals.filter((i) => i.pendingFor !== undefined);
  const overBudget = done.filter((ms) => ms > budgetMs).length;
  const abandonedOverBudget = abandoned.filter((i) => i.abandonedAfter! > budgetMs).length;
  const pendingAtEndOverBudget = pending.filter((i) => i.pendingFor! > budgetMs).length;
  const p95 = quantile(done, 0.95);
  return {
    completed: done.length,
    instant: intervals.filter((i) => i.instant).length,
    overBudget,
    p50: quantile(done, 0.5),
    p95,
    p99: quantile(done, 0.99),
    max: done.length ? done[done.length - 1] : null,
    abandoned: abandoned.length,
    abandonedOverBudget,
    pendingAtEnd: pending.length,
    pendingAtEndOverBudget,
    budgetMs,
    pass: overBudget === 0 && abandonedOverBudget === 0 && pendingAtEndOverBudget === 0,
  };
}

type Interval = { card: Element; start: number; latency?: number; abandonedAfter?: number; pendingFor?: number; instant?: boolean; closed: boolean };

const loaded = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;

/** 观察 wall 内的 `.card`：start() 开始，stop() 结束并给出报告。 */
export function createReplacementProbe(wall: HTMLElement, now: () => number = () => performance.now()) {
  const intervals: Interval[] = [];
  const open = new Map<Element, Interval>();
  let intersection: IntersectionObserver | null = null;
  let mutation: MutationObserver | null = null;
  const watched = new WeakSet<HTMLImageElement>();
  // stop() 时一并撤下挂在图片上的 load 监听，停下后的帧时间测量不再被它们影响。
  const listeners = new AbortController();

  const finish = (interval: Interval, at: number) => {
    if (interval.closed) return;
    interval.closed = true;
    interval.latency = Math.max(0, at - interval.start);
    open.delete(interval.card);
  };
  const abandon = (card: Element, at: number) => {
    const interval = open.get(card);
    if (!interval || interval.closed) return;
    interval.closed = true;
    interval.abandonedAfter = at - interval.start;
    open.delete(card);
  };
  // load 之后再 decode()：与 issue 里的定义一致，量到“可以画出来”为止。
  const settleAfterDecode = (img: HTMLImageElement) => {
    const settle = () => {
      const card = img.closest(".card");
      const interval = card && open.get(card);
      if (interval) finish(interval, now());
    };
    void (typeof img.decode === "function" ? img.decode().then(settle, settle) : settle());
  };
  const watchImage = (img: HTMLImageElement) => {
    if (watched.has(img)) return;
    watched.add(img);
    img.addEventListener("load", () => settleAfterDecode(img), { signal: listeners.signal });
  };
  const track = (card: Element) => {
    intersection?.observe(card);
    const img = card.querySelector("img");
    if (img) watchImage(img);
  };

  return {
    start() {
      intersection = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          // entry.time 是算出相交状态的那一帧，与 performance.now() 同一时基。
          const at = entry.time;
          if (entry.isIntersecting) {
            if (open.has(entry.target)) continue;
            const interval: Interval = { card: entry.target, start: at, closed: false };
            intervals.push(interval);
            open.set(entry.target, interval);
            // 已加载不等于已解码（decoding="async"）：同样等 decode() 完成再记。
            const img = entry.target.querySelector("img");
            if (img && loaded(img)) {
              interval.instant = true;
              settleAfterDecode(img);
            }
          } else {
            abandon(entry.target, at);
          }
        }
      }, { root: wall, threshold: 0 });
      mutation = new MutationObserver((records) => {
        const at = now();
        for (const record of records) {
          record.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (node.matches(".card")) track(node);
            node.querySelectorAll(".card").forEach(track);
            if (node instanceof HTMLImageElement) watchImage(node);
          });
          record.removedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            for (const card of [node, ...node.querySelectorAll(".card")]) if (open.has(card)) abandon(card, at);
          });
        }
      });
      mutation.observe(wall, { childList: true, subtree: true });
      wall.querySelectorAll(".card").forEach(track);
    },
    stop(): ReplacementReport {
      const at = now();
      intersection?.disconnect();
      mutation?.disconnect();
      listeners.abort();
      for (const interval of open.values()) {
        interval.closed = true;
        interval.pendingFor = at - interval.start;
      }
      open.clear();
      return summarizeReplacement(intervals);
    },
  };
}
