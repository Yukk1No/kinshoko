import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportTaskSnapshot } from "../../bindings/ImportTaskSnapshot";
import type { SaveDestination } from "../../bindings/SaveDestination";
import { dismissImport, importTasks, isCursorExpired, onSafeModeSetting, onWorkspaceChanged } from "../../ipc";
import { concealSuccesses, type FinishedImport, type ImportTask, type RunningImport } from "./report";

const POLL_MIN = 400, POLL_MAX = 3200;

const place = (libraryName?: string, folderName?: string) => libraryName ? `${libraryName} / ${folderName ?? "未归类"}` : null;

/**
 * 导入任务的唯一来源（#388）：后端的任务回执（跨浏览与当前图库保留），加上主窗口事件里还没进回执的进行中 /
 * 已结束任务。有进行中的任务时每 400 ms 读一次，空闲时每次加倍、最长 3.2 s；安全模式或工作区变化后立即重读，
 * 重读到达前已有回执的成功统计一起收起。内容没变时不更新状态。
 */
export function useImportTaskList({ running, finished, onDismissReport }: {
  running: RunningImport | null; finished: FinishedImport | null; onDismissReport: () => void;
}) {
  const [snapshots, setSnapshots] = useState<ImportTaskSnapshot[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const optimistic = useRef(new Map<string, ImportTaskSnapshot>());
  const dismissed = useRef(new Set<string>());
  const poke = useRef<() => void>(() => {});
  // 事件里的报告按发出时的隐私设置算；之后安全模式或工作区变了，这一份也收起成功统计。
  const latestFinished = useRef(finished);
  latestFinished.current = finished;
  const [concealed, setConcealed] = useState<FinishedImport | null>(null);
  useEffect(() => {
    let alive = true, epoch = 0, timer: ReturnType<typeof setTimeout> | undefined, delay = POLL_MIN, last = "";
    const schedule = () => { clearTimeout(timer); if (alive) timer = setTimeout(refresh, delay); };
    const invalidate = () => {
      epoch++; last = "";
      const hide = (task: ImportTaskSnapshot) => ({ ...task, progress: task.report ? { done: 0, total: 0 } : task.progress, report: task.report ? concealSuccesses(task.report) : null });
      for (const [id, task] of optimistic.current) optimistic.current.set(id, hide(task));
      setConcealed(latestFinished.current);
      setSnapshots((previous) => previous.map(hide));
      delay = POLL_MIN; schedule();
    };
    const safe = onSafeModeSetting(invalidate), workspace = onWorkspaceChanged(invalidate);
    function refresh() {
      const expected = epoch;
      void importTasks().then((value) => {
        if (!alive || expected !== epoch || !Array.isArray(value)) return;
        for (const t of value) optimistic.current.delete(t.taskId);
        const next = [...value, ...optimistic.current.values()].filter((t) => !dismissed.current.has(t.taskId));
        delay = next.some((t) => t.report === null || t.finishing) ? POLL_MIN : Math.min(delay * 2, POLL_MAX);
        const signature = JSON.stringify(next);
        if (signature !== last) { last = signature; setSnapshots(next); }
        setProblem(null);
      }, (error) => {
        // 读取期间修订变了只是过时，下一次轮询重读，不显示成问题（#98 本机 r16）。
        if (alive && expected === epoch && !isCursorExpired(error)) setProblem(String(error));
      }).finally(schedule);
    }
    poke.current = () => { delay = POLL_MIN; schedule(); };
    refresh();
    return () => { alive = false; clearTimeout(timer); poke.current = () => {}; void safe.then((stop) => stop()); void workspace.then((stop) => stop()); };
  }, []);

  // 结束事件补上占位行的回执：后端回执没读到时（如任务已从后端列表里清掉），这一行不会一直停在“正在导入”。
  useEffect(() => {
    const task = finished && optimistic.current.get(finished.taskId);
    if (!finished || !task || task.report) return;
    const next = { ...task, report: finished.report };
    optimistic.current.set(finished.taskId, next);
    setSnapshots((previous) => previous.map((t) => t.taskId === finished.taskId && !t.report ? next : t));
  }, [finished]);
  const fallback = (f: FinishedImport) => f === concealed ? concealSuccesses(f.report) : f.report;

  /** 刚开始的任务先按选好的位置占一行，等后端回执接上。 */
  const started = useCallback((taskId: string, destination: SaveDestination | undefined, libraryName: string, folderName: string) => {
    if (destination) {
      optimistic.current.set(taskId, { taskId, destination, libraryName, folderName, progress: { done: 0, total: 0 }, report: null, finishing: false, warnings: [] });
      setSnapshots((previous) => previous.some((t) => t.taskId === taskId) ? previous : [...previous, optimistic.current.get(taskId)!]);
    }
    poke.current();
  }, []);

  /** 移除一条已结束任务的记录（任务表头的 ×）。 */
  const dismiss = (task: ImportTask) => {
    optimistic.current.delete(task.taskId); dismissed.current.add(task.taskId);
    setSnapshots((previous) => previous.filter((t) => t.taskId !== task.taskId));
    if (finished?.taskId === task.taskId) onDismissReport();
    if (task.destination) void dismissImport(task.destination.libraryId, task.taskId).catch((error) => { dismissed.current.delete(task.taskId); setProblem(String(error)); });
  };

  // 主窗口只收当前图库的导入事件：导入到别的图库时它记下的“进行中”不会结束；已移除的任务不借它复活（#98 本机 r14）。
  const tasks: ImportTask[] = snapshots.map((t) => ({
    taskId: t.taskId, destination: t.destination, place: place(t.libraryName, t.folderName), finishing: t.finishing, warnings: t.warnings,
    progress: running?.taskId === t.taskId ? running.progress : t.progress,
    report: t.report ?? (finished?.taskId === t.taskId ? fallback(finished) : null),
  }));
  const known = (taskId: string | null) => taskId === null || dismissed.current.has(taskId) || tasks.some((t) => t.taskId === taskId);
  if (finished && !known(finished.taskId))
    tasks.push({ taskId: finished.taskId, destination: finished.destination, place: place(finished.libraryName, finished.folderName), progress: { done: 0, total: 0 },
      report: fallback(finished), finishing: false, warnings: [] });
  if (running?.taskId && !known(running.taskId) && running.taskId !== finished?.taskId)
    tasks.push({ taskId: running.taskId, destination: running.destination, place: place(running.libraryName, running.folderName), progress: running.progress, report: null, finishing: false, warnings: [] });
  // 启动命令还没返回 id 的导入：只有进度，没有任务回执。
  const pending = running && running.taskId === null ? running : null;

  return { tasks, pending, problem, started, dismiss, poke: () => poke.current() };
}
