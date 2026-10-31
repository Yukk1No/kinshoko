import { useEffect, useRef } from "react";
import { CircleSlash, History } from "lucide-react";
import type { RecoveryReport } from "../../bindings/RecoveryReport";
import { useToast, type ToastOptions } from "../../ui/Toast";
import { importCounts, summary, type ImportTask } from "./report";

/** 一条已结束任务的轻提示（#388 定稿）：未导入 / 有提醒的不自动消失，都带“查看”打开弹层里的这条任务。 */
function finishedToast(task: ImportTask, view: () => void): Omit<ToastOptions, "onClose"> {
  const report = task.report!;
  const rejected = importCounts(report).rejected.length;
  const stats = summary(report);
  const description = <span className="k-toast-stats">
    {task.place && <span>{task.place}</span>}
    {report.privateSummary ? <span>内容处理结果已保留</span>
      : report.cancelled ? <span>已导入 <b>{stats.find(([label]) => label === "新增")?.[1] ?? 0}</b></span>
      : stats.map(([label, n]) => <span key={label}>{label} <b>{n}</b></span>)}
  </span>;
  const action = { label: "查看", onClick: view };
  if (rejected > 0) return { title: `${rejected} 个文件未导入`, description, tone: "error", action };
  if (task.warnings.length > 0) return { title: task.warnings[0].split("，")[0], description, tone: "warn", action };
  if (report.cancelled) return { title: "导入已取消", description, tone: "info", icon: <CircleSlash size={16} />, action };
  return { title: "导入完成", description, tone: "success", action };
}

/**
 * 导入的一次性提示都走轻提示（#388）：结束、出错与上次中断。每条已结束任务一条提示，同时冒出好几条（如打开窗口时
 * 读到的旧回执）只提示最新的一条；安全模式或工作区变化收起数字时原地更新，任务移除时一并收起。
 */
export function useImportNotices({ tasks, error, clearError, recovery, view }: {
  tasks: readonly ImportTask[];
  error: string | null;
  clearError: () => void;
  recovery: RecoveryReport | null;
  /** 打开导入弹层，展开这条任务（null：上次中断那一行）。 */
  view: (taskId: string | null) => void;
}) {
  const toast = useToast();
  const latest = useRef(view);
  latest.current = view;

  // 出错进轻提示，保持到“知道了”。
  useEffect(() => {
    if (!toast || error === null) return;
    toast.error(error);
    clearError();
  }, [toast, error, clearError]);

  // 上次导入中断：打开图库时提示一次；换了图库或卸下时收起。弹层里那一行保留到画师移除。
  useEffect(() => {
    const interrupted = recovery?.interrupted.length ?? 0, orphans = recovery?.orphans.length ?? 0;
    if (!toast || (interrupted === 0 && orphans === 0)) return;
    const id = toast.show({
      title: interrupted > 0 ? "上次导入中断" : "有不认识的文件", icon: <History size={16} />, timeout: 0,
      description: [interrupted > 0 && `${interrupted} 个文件已撤回`, orphans > 0 && `原文件夹里有 ${orphans} 个不认识的文件，已保留`].filter(Boolean).join("；"),
      action: { label: "查看", onClick: () => { toast.close(id); latest.current(null); } },
    });
    return () => toast.close(id);
  }, [toast, recovery]);

  const shown = useRef(new Map<string, { id: string | null; key: string }>());
  useEffect(() => {
    if (!toast) return;
    const done = tasks.filter((task) => task.report && !task.finishing);
    const fresh = done.filter((task) => !shown.current.has(task.taskId));
    for (const task of fresh.slice(0, -1)) shown.current.set(task.taskId, { id: null, key: "" });
    for (const task of done) {
      const view = () => latest.current(task.taskId);
      const content = finishedToast(task, () => { const entry = shown.current.get(task.taskId); if (entry?.id) toast.close(entry.id); view(); });
      const key = JSON.stringify([content.title, content.tone, task.place, task.report!.privateSummary, summary(task.report!), task.warnings]);
      const entry = shown.current.get(task.taskId);
      if (!entry) {
        const id: string = toast.show({ ...content, onClose: () => { const now = shown.current.get(task.taskId); if (now) now.id = null; } });
        shown.current.set(task.taskId, { id, key });
      } else if (entry.id && entry.key !== key) {
        toast.update(entry.id, content);
        entry.key = key;
      }
    }
    // 移除了的任务：它的提示一并收起。
    for (const [taskId, entry] of shown.current) {
      if (entry.id && !done.some((task) => task.taskId === taskId)) { toast.close(entry.id); entry.id = null; }
    }
  }, [toast, tasks]);

  /** 从弹层里看过这条任务：它的提示不再需要。 */
  const seen = (taskId: string) => { const entry = shown.current.get(taskId); if (entry?.id) { toast?.close(entry.id); entry.id = null; } };
  return { toast, seen };
}
