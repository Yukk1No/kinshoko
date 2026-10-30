import { useEffect, useRef, useState } from "react";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { useToast } from "../ui/Toast";
import type { FinishedImport } from "./ImportBar";
import { importNotice } from "./ImportBarParts";

/**
 * 导入的一次性提示走轻提示管线（#388）：结束、出错、上次中断与封印项重复。结束的提示带“查看”，打开结果回执卡；
 * 回执也可从导入菜单的“导入任务”打开。没有 ToastProvider 时 toast 为 null，导入条退回原来的卡片，回执一直显示。
 */
export function useImportNotices({ finished, owner, recovery, setRecovery, importError, setImportError, reimport, sealedTask, showSealed }: {
  finished: FinishedImport | null;
  owner: string | null;
  recovery: RecoveryReport | null;
  setRecovery: (value: null) => void;
  importError: string | null;
  setImportError: (value: null) => void;
  /** 重新导入上次中断时撤回的文件。 */
  reimport: (paths: string[]) => void;
  sealedTask: string | null;
  showSealed: (taskId: string) => void;
}) {
  const toast = useToast();
  /** 打开着的结果回执（按任务 id）。 */
  const [receipt, setReceipt] = useState<string | null>(null);
  const report = finished?.report ?? null;

  // 出错进轻提示，保持到“知道了”。
  useEffect(() => {
    if (!toast || importError === null) return;
    toast.error(importError);
    setImportError(null);
  }, [toast, importError, setImportError]);

  // 上次导入中断或原文件夹里有不认识的文件：打开图库时提示一次，可直接重新导入撤回的文件。
  const latest = useRef({ reimport, setRecovery });
  latest.current = { reimport, setRecovery };
  useEffect(() => {
    const interrupted = recovery?.interrupted ?? [], orphans = recovery?.orphans ?? [];
    if (!toast || (interrupted.length === 0 && orphans.length === 0)) return;
    const id = toast.show({
      title: interrupted.length > 0 ? "上次导入中断" : "有不认识的文件",
      description: [interrupted.length > 0 && `${interrupted.length} 个文件已撤回，没有留下半张图`,
        orphans.length > 0 && `图库的原文件夹里有 ${orphans.length} 个不认识的文件，已保留`].filter(Boolean).join("；"),
      timeout: 0,
      action: interrupted.length > 0 ? { label: "重新导入", onClick: () => { toast.close(id); latest.current.reimport(interrupted); } } : undefined,
      onClose: () => latest.current.setRecovery(null),
    });
  }, [toast, recovery]);

  // 导入结束：每个任务一条轻提示；安全模式或工作区变化收起数字时，已显示的提示原地更新（notice.key 概括了提示内容）。
  const notice = report && finished ? importNotice(report, owner) : null;
  const shownNotices = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (!toast || !finished || !notice) return;
    const taskId = finished.taskId;
    if (shownNotices.current.has(taskId)) {
      const id = shownNotices.current.get(taskId);
      if (id) toast.update(id, notice.toast(() => { toast.close(id); setReceipt(taskId); }));
      return;
    }
    // 回执正开着（例如从任务切换里选中它）时不再另外提示。
    if (receipt === taskId) { shownNotices.current.set(taskId, null); return; }
    const id: string = toast.show({ ...notice.toast(() => { toast.close(id); setReceipt(taskId); }), onClose: () => shownNotices.current.set(taskId, null) });
    shownNotices.current.set(taskId, id);
  }, [toast, finished?.taskId, notice?.key]);

  // 封印项重复：#78 规定的原文，不点名内容类别，不给数量。
  const show = useRef(showSealed);
  show.current = showSealed;
  useEffect(() => {
    if (!toast || sealedTask === null) return;
    const id = toast.show({ title: "有封印项重复，是否展开看看", action: { label: "展开", onClick: () => { toast.close(id); show.current(sealedTask); } } });
    return () => toast.close(id);
  }, [toast, sealedTask]);

  return { toast, receiptOpen: report !== null && (!toast || receipt === finished?.taskId), setReceipt };
}
