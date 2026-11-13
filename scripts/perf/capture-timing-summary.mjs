// 原样从 capture-timing.mjs 移出。

/** 中位数／最大值汇总，便于修复前后对比。 */
export function summarize(r) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
  const stat = (a) => (a.length ? { median: median(a), max: Math.max(...a), n: a.length } : null);
  const rest = r.runs.filter((x) => !x.appColdStart);
  const out = {
    firstCaptureShown: r.runs.find((x) => x.appColdStart)?.stages.shown ?? null,
    keyToShown: stat(rest.map((x) => x.stages.shown)),
    keyToWindowReady: stat(rest.map((x) => x.stages.windowBuilt)),
    frozenPng: stat(rest.map((x) => x.stages.pngEnd - x.stages.pngBegin)),
    referenceRuns: `${r.runs.filter((x) => x.result.original).length}/${r.runs.length}`,
    images: {},
  };
  for (const image of [...new Set(r.runs.map((x) => x.image))].sort()) {
    const of = (action) => r.runs.filter((x) => x.image === image && x.action === action && x.result.original);
    out.images[image] = { copyToClipboard: of("copy").map((x) => x.result.finishEnd), pinToShown: of("pin").map((x) => x.result.harnessPinShown) };
  }
  if (r.tray) out.tray = r.tray.map((t) => ({ gapMs: t.gapMs, shown: t.shown }));
  if (r.memory) out.memory = r.memory;
  return out;
}
