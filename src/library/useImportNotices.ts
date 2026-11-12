import { useEffect, useRef, useState } from "react";
import { onSafeModeSetting, onWorkspaceChanged } from "../ipc";
import { useToast } from "../ui/Toast";
import { useTranslation } from "react-i18next";
import type { FinishedImport } from "./ImportBar";
import type { SaveDestination } from "../bindings/SaveDestination";
import { importNotice } from "./ImportBarParts";
import type { LibraryRecovery } from "./useImportRecovery";

/**
 * 导入的一次性提示走轻提示管线（#388）：结束、出错、上次中断与封印项重复。结束的提示带“查看”，打开结果回执卡；
 * 回执也可从导入菜单的“导入任务”打开。
 */
export function useImportNotices({ finished, owner, warnings = [], onSelectTask, onShowDestination, recovery, dismissRecovery, reimport, sealedTask, showSealed }: {
  finished: FinishedImport | null;
  owner: string | null;
  warnings?: readonly string[];
  /** 让导入菜单选中某个任务：“查看”先选中它，回执显示的才是这条提示的任务。 */
  onSelectTask?: (taskId: string) => void;
  /** 去导入的位置（图库与文件夹）看结果。 */
  onShowDestination?: (destination: SaveDestination) => void;
  recovery: LibraryRecovery | null;
  dismissRecovery: (recovery: LibraryRecovery) => void;
  /** 把上次中断时撤回的文件重新导入回它们所在的资料库。 */
  reimport: (paths: string[], libraryId: string) => void;
  sealedTask: string | null;
  showSealed: (taskId: string) => void;
}) {
  const toast = useToast();
  const { t } = useTranslation("importing");
  /** 结果回执是否打开；打开时随导入菜单所选的任务切换。 */
  const [receipt, setReceipt] = useState(false);
  const report = finished?.report ?? null;
  const latest = useRef({ reimport, onSelectTask, showSealed, onShowDestination });
  latest.current = { reimport, onSelectTask, showSealed, onShowDestination };

  // 上次导入中断或原文件夹里有不认识的文件：每个图库提示一次，可直接把撤回的文件重新导入回那个图库。
  // biome-ignore lint/correctness/useExhaustiveDependencies(t): 换界面语言不收起重弹这条提示
  useEffect(() => {
    if (!recovery) return;
    const { interrupted, orphans } = recovery.report;
    let current = true;
    const id = toast.show({
      title: interrupted.length > 0 ? t("recovery.interrupted") : t("recovery.orphans"),
      description: t("recovery.inLibrary", { library: recovery.libraryName, summary: [interrupted.length > 0 && t("recovery.withdrawn", { count: interrupted.length }),
        orphans.length > 0 && t("recovery.kept", { count: orphans.length })].filter(Boolean).join(t("recovery.separator")) }),
      timeout: 0,
      action: interrupted.length > 0 ? { label: t("recovery.reimport"), onClick: () => { if (!current) return; toast.close(id); latest.current.reimport(interrupted, recovery.libraryId); } } : undefined,
      onClose: () => { if (current) dismissRecovery(recovery); },
    });
    return () => { current = false; toast.close(id); };
  }, [toast, recovery, dismissRecovery]);

  // 导入结束：每个任务一条轻提示；安全模式或工作区变化收起数字时，已显示的提示原地更新（notice.key 概括了提示内容）。
  const notice = report && finished ? importNotice(report, owner, warnings) : null;
  const shownNotices = useRef(new Map<string, string | null>());
  const view = (taskId: string, id: string) => () => { toast.close(id); latest.current.onSelectTask?.(taskId); setReceipt(true); };
  const target = finished?.destination ?? (finished?.libraryId ? { libraryId: finished.libraryId, folderId: null } : null);
  const show = (id: string) => target && onShowDestination ? () => { toast.close(id); latest.current.onShowDestination?.(target); } : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按任务与 notice.key 判断要不要显示或原地更新；notice、view、show 每次渲染都是新的，receipt 只在提示出现那一刻读
  useEffect(() => {
    if (!finished || !notice) return;
    const taskId = finished.taskId;
    if (shownNotices.current.has(taskId)) {
      const id = shownNotices.current.get(taskId);
      if (id) toast.update(id, notice.toast(view(taskId, id), show(id)));
      return;
    }
    // 回执正开着时它已显示这个任务，不再另外提示。
    if (receipt) { shownNotices.current.set(taskId, null); return; }
    const id: string = toast.show({ ...notice.toast(() => view(taskId, id)(), target && onShowDestination ? () => show(id)?.() : undefined), onClose: () => shownNotices.current.set(taskId, null) });
    shownNotices.current.set(taskId, id);
  }, [toast, finished?.taskId, notice?.key]);
  // 安全模式或工作区变化时，别的任务留着的提示无法跟着收起数字，直接收起；所选任务的提示由上面原地更新。
  const selectedTask = useRef<string | null>(null);
  selectedTask.current = finished?.taskId ?? null;
  useEffect(() => {
    const conceal = () => {
      for (const [taskId, id] of shownNotices.current) {
        if (id && taskId !== selectedTask.current) { toast.close(id); shownNotices.current.set(taskId, null); }
      }
    };
    const safe = onSafeModeSetting(conceal), workspace = onWorkspaceChanged(conceal);
    return () => { void safe.then((stop) => stop()); void workspace.then((stop) => stop()); };
  }, [toast]);

  // 封印项重复：#78 规定的原文，不点名内容类别，不给数量。错过时可从回执里再展开。
  // biome-ignore lint/correctness/useExhaustiveDependencies(t): 换界面语言不收起重弹这条提示
  useEffect(() => {
    if (sealedTask === null) return;
    const id = toast.show({ title: t("sealed.prompt"), action: { label: t("sealed.expand"), onClick: () => { toast.close(id); latest.current.showSealed(sealedTask); } } });
    return () => toast.close(id);
  }, [toast, sealedTask]);

  /** 回执关掉（任务回执被删除）时，它的结束提示也收起，免得“查看”指向已不存在的任务。 */
  const closeReceipt = (taskId: string | undefined) => {
    setReceipt(false);
    const id = taskId === undefined ? null : shownNotices.current.get(taskId);
    if (taskId !== undefined && id) { toast.close(id); shownNotices.current.set(taskId, null); }
  };
  return { receiptOpen: report !== null && receipt, setReceipt, closeReceipt };
}
