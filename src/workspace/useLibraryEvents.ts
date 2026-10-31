import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { onLibraryEvent, onOrganizeWaiting } from "../ipc";
import type { FinishedImport, RunningImport } from "../library/ImportBar";
import { safeTiming } from "../shell/safeTiming";
import type { ToastApi } from "../ui/Toast";
import type { ImportTasks } from "./useImportTasks";
import type { Invalidate } from "./useInvalidation";

/** 资料库事件：列表与词表失效、安全模式确认、导入进度与结束；另一个图库整理等导入收尾时的轻提示。 */
export function useLibraryEvents({
  libraryId, toast, imports, invalidate, safeChanged, keepSelectionOnSafeRef, setRunning, setReport,
}: {
  libraryId: string;
  toast: ToastApi | null;
  imports: RefObject<ImportTasks>;
  invalidate: Invalidate;
  safeChanged: RefObject<(on: boolean) => void>;
  keepSelectionOnSafeRef: RefObject<boolean>;
  setRunning: Dispatch<SetStateAction<RunningImport | null>>;
  setReport: Dispatch<SetStateAction<FinishedImport | null>>;
}) {
  // 整理另一个图库时它的导入正在收尾（ADR-0008，#112）：后端等收尾结束再执行，这里只给轻提示。
  useEffect(() => {
    let alive = true;
    const unlisten = onOrganizeWaiting((waiting) => {
      if (!alive) return;
      const names = waiting.finishing.map((name) => `「${name}」`).join("、");
      toast?.show({ title: "导入收尾后再整理", description: `${names}的导入完成后自动执行` });
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [toast]);
  useEffect(() => {
    let alive = true;
    const unlisten = onLibraryEvent((event) => {
      if (!alive) return;
      // 后端按需把可写句柄切到正在整理的图库（ADR-0008）：任何图库的列表或词表变化都只让界面重读；
      // 安全模式与导入事件只认这个界面打开的图库，另一个库的不串台。
      const invalidation = event.kind === "listStale" || event.kind === "vocabularyChanged" || event.kind === "imagesChanged";
      if (event.libraryId !== libraryId && !invalidation) return;
      const task = imports.current;
      switch (event.kind) {
        case "listStale":
          invalidate({ kind: "listInvalidated" });
          break;
        case "vocabularyChanged":
        case "imagesChanged":
          invalidate({ kind: "vocabularyInvalidated" });
          break;
        case "safeModeChanged":
          safeChanged.current(event.on);
          // 选中或正在查看的图可能已被封印：开启时关闭查看器回到图片墙；
          // 默认同时清掉选择，设为保留时由重读后的修剪只去掉被封印的图。
          invalidate({ kind: "safeConfirmed", on: event.on, keepSelection: keepSelectionOnSafeRef.current });
          // 关闭：查询视角在后端确认时才放开，放开那一刻整批重读一次（#183）。
          if (!event.on) safeTiming.mark("library-event");
          break;
        case "taskProgress":
          // 已结束的任务不再复活；另一个任务正在进行时，旧任务的进度不覆盖它。
          if (task.finished.has(event.taskId) || task.other(event.taskId)) break;
          task.running = event.taskId;
          setRunning({ taskId: event.taskId, progress: event.progress });
          break;
        case "taskFinished":
          if (task.finished.has(event.taskId) || task.other(event.taskId)) break;
          task.finished.add(event.taskId);
          task.running = null;
          setRunning(null);
          setReport({ taskId: event.taskId, report: event.report });
          break;
      }
    });
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, [libraryId]);
}
