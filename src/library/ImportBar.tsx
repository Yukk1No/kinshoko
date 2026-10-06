import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportReport } from "../bindings/ImportReport";
import { cancelImport, pickFiles, pickFolder, startImport } from "../ipc";

export type RunningImport = { taskId: string | null; progress: ImportProgress };

type Props = {
  running: RunningImport | null;
  report: ImportReport | null;
  onStarted: (taskId: string) => void;
  onDismissReport: () => void;
};

function reason(outcome: ImportOutcome): string | null {
  switch (outcome.kind) {
    case "unsupported":
      return "不支持的格式";
    case "readFailed":
      return `读取失败：${outcome.reason}`;
    default:
      return null;
  }
}

/** 导入：选择文件或文件夹；进行中显示进度与取消，结束后逐项列出没有进来的文件。 */
export function ImportBar({ running, report, onStarted, onDismissReport }: Props) {
  const begin = async (paths: string[]) => {
    if (paths.length) onStarted(await startImport(paths));
  };
  const importFiles = async () => begin(await pickFiles());
  const importFolder = async () => {
    const folder = await pickFolder();
    await begin(folder ? [folder] : []);
  };

  const { done = 0, total = 0 } = running?.progress ?? {};
  const counts = report && {
    imported: report.items.filter((i) => i.outcome.kind === "imported").length,
    merged: report.items.filter((i) => i.outcome.kind === "merged").length,
    rejected: report.items.filter((i) => reason(i.outcome) !== null),
  };

  return (
    <div className="import-bar">
      <div className="import-actions">
        <button type="button" onClick={importFiles} disabled={!!running}>
          导入文件…
        </button>
        <button type="button" onClick={importFolder} disabled={!!running}>
          导入文件夹…
        </button>
      </div>
      {running && (
        <div className="import-progress">
          <progress
            max={Math.max(total, 1)}
            value={done}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          />
          <span>
            正在导入 {done} / {total}
          </span>
          <button
            type="button"
            onClick={() => running.taskId && cancelImport(running.taskId)}
            disabled={!running.taskId}
          >
            取消导入
          </button>
        </div>
      )}
      {report && counts && (
        <section className="import-report" aria-label="导入结果">
          <header>
            <span>
              {report.cancelled ? "导入已取消" : "导入完成"}：新增 {counts.imported} 张
              {counts.merged > 0 && `，与已有图相同而合并 ${counts.merged} 张`}
              {counts.rejected.length > 0 && `，${counts.rejected.length} 个文件没有导入`}
            </span>
            <button type="button" onClick={onDismissReport}>
              关闭
            </button>
          </header>
          {counts.rejected.length > 0 && (
            <ul>
              {counts.rejected.map((item) => (
                <li key={item.path}>
                  <span className="import-report-path">{item.path}</span>
                  <span className="import-report-reason">{reason(item.outcome)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
