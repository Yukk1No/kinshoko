import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { onSafeModeSetting, onWorkspaceChanged } from "../ipc";
import { useToast } from "../ui/Toast";
import type { FinishedImport } from "./ImportBar";
import { importNotice } from "./ImportBarParts";

/**
 * 导入的一次性提示走轻提示管线（#388）：结束、出错、上次中断与封印项重复。结束的提示带“查看”，打开结果回执卡；
 * 回执也可从导入菜单的“导入任务”打开。没有 ToastProvider 时 toast 为 null，导入条退回原来的卡片，回执一直显示。
 */
export function useImportNotices({ finished, owner, warnings = [], onSelectTask, recovery, setRecovery, importError, setImportError, reimport, sealedTask, showSealed }: {
  finished: FinishedImport | null;
  owner: string | null;
  warnings?: readonly string[];
  /** 让导入菜单选中某个任务：“查看”先选中它，回执显示的才是这条提示的任务。 */
  onSelectTask?: (taskId: string) => void;
  recovery: RecoveryReport | null;
  setRecovery: Dispatch<SetStateAction<RecoveryReport | null>>;
  importError: string | null;
  setImportError: (value: null) => void;
  /** 重新导入上次中断时撤回的文件。 */
  reimport: (paths: string[]) => void;
  sealedTask: string | null;
  showSealed: (taskId: string) => void;
}) {
  const toast = useToast();
  /** 结果回执是否打开；打开时随导入菜单所选的任务切换。 */
  const [receipt, setReceipt] = useState(false);
  const report = finished?.report ?? null;
  const latest = useRef({ reimport, onSelectTask, showSealed });
  latest.current = { reimport, onSelectTask, showSealed };

  // 出错进轻提示，保持到“知道了”。
  useEffect(() => {
    if (!toast || importError === null) return;
    toast.error(importError);
    setImportError(null);
  }, [toast, importError, setImportError]);

  // 上次导入中断或原文件夹里有不认识的文件：打开图库时提示一次，可直接重新导入撤回的文件。
  // 换了图库（重新读取恢复报告）或卸下时收起，旧提示不会把上一个图库的文件导进新位置，也不会清掉新报告。
  useEffect(() => {
    const interrupted = recovery?.interrupted ?? [], orphans = recovery?.orphans ?? [];
    if (!toast || (interrupted.length === 0 && orphans.length === 0)) return;
    let current = true;
    const id = toast.show({
      title: interrupted.length > 0 ? "上次导入中断" : "有不认识的文件",
      description: [interrupted.length > 0 && `${interrupted.length} 个文件已撤回，没有留下半张图`,
        orphans.length > 0 && `图库的原文件夹里有 ${orphans.length} 个不认识的文件，已保留`].filter(Boolean).join("；"),
      timeout: 0,
      action: interrupted.length > 0 ? { label: "重新导入", onClick: () => { if (!current) return; toast.close(id); latest.current.reimport(interrupted); } } : undefined,
      onClose: () => { if (current) setRecovery((value) => value === recovery ? null : value); },
    });
    return () => { current = false; toast.close(id); };
  }, [toast, recovery, setRecovery]);

  // 导入结束：每个任务一条轻提示；安全模式或工作区变化收起数字时，已显示的提示原地更新（notice.key 概括了提示内容）。
  const notice = report && finished ? importNotice(report, owner, warnings) : null;
  const shownNotices = useRef(new Map<string, string | null>());
  const view = (taskId: string, id: string) => () => { toast?.close(id); latest.current.onSelectTask?.(taskId); setReceipt(true); };
  useEffect(() => {
    if (!toast || !finished || !notice) return;
    const taskId = finished.taskId;
    if (shownNotices.current.has(taskId)) {
      const id = shownNotices.current.get(taskId);
      if (id) toast.update(id, notice.toast(view(taskId, id)));
      return;
    }
    // 回执正开着时它已显示这个任务，不再另外提示。
    if (receipt) { shownNotices.current.set(taskId, null); return; }
    const id: string = toast.show({ ...notice.toast(() => view(taskId, id)()), onClose: () => shownNotices.current.set(taskId, null) });
    shownNotices.current.set(taskId, id);
  }, [toast, finished?.taskId, notice?.key]);
  // 安全模式或工作区变化时，别的任务留着的提示无法跟着收起数字，直接收起；所选任务的提示由上面原地更新。
  const selectedTask = useRef<string | null>(null);
  selectedTask.current = finished?.taskId ?? null;
  useEffect(() => {
    if (!toast) return;
    const conceal = () => {
      for (const [taskId, id] of shownNotices.current) {
        if (id && taskId !== selectedTask.current) { toast.close(id); shownNotices.current.set(taskId, null); }
      }
    };
    const safe = onSafeModeSetting(conceal), workspace = onWorkspaceChanged(conceal);
    return () => { void safe.then((stop) => stop()); void workspace.then((stop) => stop()); };
  }, [toast]);

  // 封印项重复：#78 规定的原文，不点名内容类别，不给数量。错过时可从回执里再展开。
  useEffect(() => {
    if (!toast || sealedTask === null) return;
    const id = toast.show({ title: "有封印项重复，是否展开看看", action: { label: "展开", onClick: () => { toast.close(id); latest.current.showSealed(sealedTask); } } });
    return () => toast.close(id);
  }, [toast, sealedTask]);

  return { toast, receiptOpen: report !== null && (!toast || receipt), setReceipt };
}
