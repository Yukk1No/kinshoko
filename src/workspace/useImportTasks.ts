import { useRef, useState } from "react";
import type { FinishedImport, RunningImport } from "../library/ImportBar";

/** 导入任务按 id 记下的终态（#76）。 */
export type ImportTasks = {
  finished: Set<string>;
  running: string | null;
  /** 正在进行的是另一个任务。 */
  other(taskId: string): boolean;
};

/** 正在进行的导入与上一次的结果；`started` 在启动命令返回时记下任务。 */
export function useImportTasks() {
  const [running, setRunning] = useState<RunningImport | null>(null);
  const [report, setReport] = useState<FinishedImport | null>(null);
  /**
   * 导入任务按 id 记下终态（#76）：结束事件、启动命令的响应与进度事件到达的顺序不定，
   * 已结束的任务不能被迟到的响应或进度复活，旧任务的事件也不能覆盖正在进行的新任务。
   */
  const imports = useRef({
    finished: new Set<string>(),
    running: null as string | null,
    /** 正在进行的是另一个任务。 */
    other(taskId: string) {
      return this.running !== null && this.running !== taskId;
    },
  });

  const started = (taskId: string) => {
    const task = imports.current;
    // 结束事件可能先于命令返回到达：任务已有终态，迟到的响应不再复活它（#76）。
    if (task.finished.has(taskId)) return;
    task.running = taskId;
    setReport(null);
    // 进度事件可能先于命令返回到达，那时已经有了任务。
    setRunning((r) => (r?.taskId === taskId ? r : { taskId, progress: { done: 0, total: 0 } }));
  };

  return { imports, running, setRunning, report, setReport, started };
}
