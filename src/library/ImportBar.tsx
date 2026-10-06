import { useEffect, useRef, useState } from "react";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportReport } from "../bindings/ImportReport";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import { cancelImport, libraryRecovery, onFileDrop, pickFiles, pickFolder, startImport } from "../ipc";

export type RunningImport = { taskId: string | null; progress: ImportProgress };

type Props = {
  enabled: boolean;
  libraryId: string;
  libraryName: string;
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

/**
 * 导入：选择文件或文件夹，或把它们拖进主窗口；进行中显示进度与取消，结束后逐项列出
 * 没有进来的文件并可只重试读取失败的项。打开资料库时若上次导入中断，提示撤回了哪些文件。
 */
export function ImportBar({ enabled, libraryId, libraryName, running, report, onStarted, onDismissReport }: Props) {
  const [hovering, setHovering] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) setHovering(false);
  }, [enabled]);

  const begin = async (paths: string[]) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    try {
      setError(null);
      const taskId = await startImport(libraryId, paths);
      if (alive.current) onStarted(taskId);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  };
  const importFiles = async () => begin(await pickFiles());
  const importFolder = async () => {
    const folder = await pickFolder();
    await begin(folder ? [folder] : []);
  };

  // 拖放的回调只注册一次，经 ref 读到最新的状态。
  const latest = useRef({ running, begin });
  latest.current = { running, begin };
  useEffect(() => {
    const unlisten = onFileDrop((drop) => {
      if (!alive.current || !enabledRef.current) return;
      switch (drop.kind) {
        case "enter":
          setHovering(!latest.current.running);
          break;
        case "drop":
          setHovering(false);
          if (!latest.current.running) void latest.current.begin(drop.paths);
          break;
        case "leave":
          setHovering(false);
          break;
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    libraryRecovery(libraryId).then(
      (value) => alive && setRecovery(value),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const { done = 0, total = 0 } = running?.progress ?? {};
  const counts = report && {
    imported: report.items.filter((i) => i.outcome.kind === "imported").length,
    merged: report.items.filter((i) => i.outcome.kind === "merged").length,
    rejected: report.items.filter((i) => reason(i.outcome) !== null),
    failed: report.items.filter((i) => i.outcome.kind === "readFailed").map((i) => i.path),
  };
  const interrupted = recovery?.interrupted ?? [];
  const orphans = recovery?.orphans ?? [];

  return (
    <div className="import-bar">
      {error && <p role="alert">{error}</p>}
      <div className="import-actions">
        <button type="button" onClick={importFiles} disabled={!!running}>
          导入文件…
        </button>
        <button type="button" onClick={importFolder} disabled={!!running}>
          导入文件夹…
        </button>
      </div>
      {hovering && (
        <div className="drop-hint" aria-live="polite">
          松开即可导入到 {libraryName}
        </div>
      )}
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
            onClick={() => running.taskId && cancelImport(libraryId, running.taskId).catch((e) => alive.current && setError(String(e)))}
            disabled={!running.taskId}
          >
            取消导入
          </button>
        </div>
      )}
      {(interrupted.length > 0 || orphans.length > 0) && (
        <section
          className="import-report"
          role="status"
          aria-label={interrupted.length > 0 ? "上次导入中断" : "原文件夹里有不认识的文件"}
        >
          <header>
            <span>
              {interrupted.length > 0 &&
                `上次导入中断，${interrupted.length} 个文件已撤回，没有留下半张图`}
              {interrupted.length > 0 && orphans.length > 0 && "；"}
              {orphans.length > 0 &&
                `资料库的原文件夹里有 ${orphans.length} 个不认识的文件，已保留未删除`}
            </span>
            {interrupted.length > 0 && (
              <button
                type="button"
                disabled={!!running}
                onClick={() => {
                  void begin(interrupted);
                  setRecovery(null);
                }}
              >
                重新导入这些文件
              </button>
            )}
            <button type="button" onClick={() => setRecovery(null)}>
              关闭
            </button>
          </header>
          {interrupted.length > 0 && (
            <ul>
              {interrupted.map((path) => (
                <li key={path}>
                  <span className="import-report-path">{path}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {report && counts && (
        <section className="import-report" aria-label="导入结果">
          <header>
            <span>
              {report.cancelled ? "导入已取消" : "导入完成"}：新增 {counts.imported} 张
              {counts.merged > 0 && `，与已有图相同而合并 ${counts.merged} 张`}
              {counts.rejected.length > 0 && `，${counts.rejected.length} 个文件没有导入`}
            </span>
            {counts.failed.length > 0 && (
              <button type="button" disabled={!!running} onClick={() => void begin(counts.failed)}>
                重试失败的 {counts.failed.length} 项
              </button>
            )}
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
