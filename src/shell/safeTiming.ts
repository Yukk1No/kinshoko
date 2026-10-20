/**
 * 安全模式切换的分段耗时（#183）：开发构建或性能构建（VITE_KINSHOKO_PERF=1）里从点下开关算起，各段第一次出现时记一笔，
 * 在开发者工具的控制台（verbose）与性能面板（`safe-mode:*`）里读出。只记点下后几秒内的。
 * 与后端 `set_safe_mode`、`workspace_browse` 的开发构建输出对照着看。
 */
export type SafeStage = "后端确认" | "资料库事件" | "开始重新浏览" | "卡片送回" | "释放动画开始";

const WINDOW_MS = 5000;
/** 构建时折叠为常量，发行构建不记录。 */
const ENABLED = import.meta.env.DEV || import.meta.env.VITE_KINSHOKO_PERF === "1";
let started: number | null = null;
const seen = new Set<SafeStage>();

export const safeTiming = {
  toggled(on: boolean) {
    if (!ENABLED) return;
    started = performance.now();
    seen.clear();
    try { performance.mark("safe-mode:toggle"); } catch { /* 没有性能面板时只写控制台 */ }
    console.debug(`[安全模式] 点下 → ${on ? "开" : "关"}`);
  },
  mark(stage: SafeStage) {
    if (started === null || seen.has(stage)) return;
    const ms = performance.now() - started;
    if (ms > WINDOW_MS) { started = null; return; }
    seen.add(stage);
    try { performance.measure(`safe-mode:${stage}`, "safe-mode:toggle"); } catch { /* 同上 */ }
    console.debug(`[安全模式] ${stage} +${ms.toFixed(1)} ms`);
  },
};
