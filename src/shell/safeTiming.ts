/**
 * 安全模式切换的分段耗时（#183）：从点下开关算起，各段第一次出现时记一笔，
 * 在开发者工具的控制台（verbose）与性能面板（`safe-mode:*`）里读出。只记点下后几秒内的。
 */
const WINDOW_MS = 5000;
let started: number | null = null;
const seen = new Set<string>();

export const safeTiming = {
  toggled(on: boolean) {
    started = performance.now();
    seen.clear();
    try { performance.mark("safe-mode:toggle"); } catch { /* 没有性能面板时只写控制台 */ }
    console.debug(`[安全模式] 点下 → ${on ? "开" : "关"}`);
  },
  mark(stage: string) {
    if (started === null || seen.has(stage)) return;
    const ms = performance.now() - started;
    if (ms > WINDOW_MS) { started = null; return; }
    seen.add(stage);
    try { performance.measure(`safe-mode:${stage}`, "safe-mode:toggle"); } catch { /* 同上 */ }
    console.debug(`[安全模式] ${stage} +${ms.toFixed(1)} ms`);
  },
};
