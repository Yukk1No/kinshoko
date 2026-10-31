import type { ImportItem } from "../../bindings/ImportItem";
import type { ImportOptions } from "../../bindings/ImportOptions";
import type { ImportOutcome } from "../../bindings/ImportOutcome";
import type { ImportProgress } from "../../bindings/ImportProgress";
import type { ImportReport } from "../../bindings/ImportReport";
import type { SaveDestination } from "../../bindings/SaveDestination";

/** 主窗口事件里正在进行的导入（启动命令返回前可能还没有 id）。 */
export type RunningImport = { taskId: string | null; progress: ImportProgress; libraryId?: string; destination?: SaveDestination; libraryName?: string; folderName?: string };
/** 主窗口事件里已结束的导入任务与它的报告。 */
export type FinishedImport = { taskId: string; report: ImportReport; libraryId?: string; destination?: SaveDestination; libraryName?: string; folderName?: string };
/** 导入确认对话框里的一次导入。 */
export type ImportPlan = { paths: string[]; options: ImportOptions; eagle: boolean };

/** 导入弹层里的一条任务：后端任务回执，或主窗口事件补上的进行中 / 已结束任务。 */
export type ImportTask = {
  taskId: string;
  destination?: SaveDestination;
  /** “图库 / 文件夹”，任务行的标题；不知道时为 null。 */
  place: string | null;
  progress: ImportProgress;
  report: ImportReport | null;
  /** 内容已导入，正在把标签定义存进图库。 */
  finishing: boolean;
  warnings: readonly string[];
};

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
/** 文件所在文件夹（含末尾分隔符），未导入清单的第二行。 */
export const folderOf = (path: string) => { const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")); return at < 0 ? "" : path.slice(0, at + 1); };

export function reason(outcome: ImportOutcome): string | null {
  switch (outcome.kind) {
    case "unsupported": return "不支持的格式";
    case "readFailed": return outcome.reason;
    default: return null;
  }
}

/** 一份报告的分类：数字一栏与需要处理的几类。 */
export function importCounts(report: ImportReport) {
  const count = (kind: ImportOutcome["kind"]) => report.items.filter((i) => i.outcome.kind === kind).length;
  return {
    imported: count("imported"), merged: count("merged"), refreshed: count("refreshed"), newVersions: count("newVersion"),
    /** 未导入：不支持的格式与读取失败。 */
    rejected: report.items.filter((i): i is ImportItem => reason(i.outcome) !== null),
    failed: report.items.filter((i) => i.outcome.kind === "readFailed").map((i) => i.path),
    skippedDeleted: report.items.filter((i) => i.outcome.kind === "skippedDeleted").map((i) => i.path),
    /** 回收站里有重复：只是一个布尔提示，不给名字与数量（#78）。 */
    trashDuplicate: report.trashDuplicates || report.items.some((i) => i.outcome.kind === "trashDuplicate"),
  };
}

/** 回执里有没有要画师处理的：未导入、删过的图、回收站、封印重复或任务警告。 */
export const needsReview = (task: ImportTask) => {
  if (!task.report) return false;
  const c = importCounts(task.report);
  return c.rejected.length > 0 || c.skippedDeleted.length > 0 || c.trashDuplicate || task.report.sealedDuplicates || task.warnings.length > 0;
};

/** 收起的任务行与轻提示里的摘要数字：新增总在，其余大于 0 才列；数字被收起时为空。 */
export function summary(report: ImportReport): [string, number][] {
  if (report.privateSummary) return [];
  const c = importCounts(report);
  return ([["新增", c.imported], ["已存在", c.merged], ["更新", c.refreshed], ["新版本", c.newVersions]] as [string, number][])
    .filter(([label, n]) => label === "新增" || n > 0);
}

/** 安全模式或工作区变化后、新回执到来前：保留要重试的项，成功的各类一起收起（不能相减出子集）。 */
export function concealSuccesses(report: ImportReport): ImportReport {
  return { ...report, privateSummary: true, eagleMissing: 0,
    trashDuplicates: report.trashDuplicates || report.items.some((item) => item.outcome.kind === "trashDuplicate"),
    items: report.items.filter((item) => ["readFailed", "unsupported", "skippedDeleted"].includes(item.outcome.kind)) };
}
