import { useEffect, useRef, useState } from "react";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportReport } from "../bindings/ImportReport";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import type { EagleLibraryCandidate } from "../bindings/EagleLibraryCandidate";
import { cancelImport, discoverEagleLibraries, libraryRecovery, onFileDrop, pickFiles, pickFolder, startImport } from "../ipc";

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
  const [eagleLibraries, setEagleLibraries] = useState<EagleLibraryCandidate[] | null>(null);
  const [lookingForEagle, setLookingForEagle] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // 切换资料库后旧工作区已卸下；新建表单打开时工作区只是隐藏，不接受导入。
  const alive = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) setHovering(false);
  }, [enabled]);

  const begin = async (paths: string[]) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    try {
      setImportError(null);
      const taskId = await startImport(libraryId, paths);
      if (!alive.current) return;
      onStarted(taskId);
      setEagleLibraries(null);
    } catch (error) {
      if (alive.current) setImportError(`无法开始导入：${String(error)}`);
    }
  };
  const importFiles = async () => begin(await pickFiles());
  const importFolder = async () => {
    const folder = await pickFolder();
    await begin(folder ? [folder] : []);
  };
  const findEagle = async () => {
    setLookingForEagle(true);
    setImportError(null);
    try {
      const found = await discoverEagleLibraries();
      if (alive.current) setEagleLibraries(found);
    } catch (error) {
      if (alive.current) setImportError(`无法查找 Eagle 资料库：${String(error)}`);
    } finally {
      if (alive.current) setLookingForEagle(false);
    }
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
  }, [libraryId]);

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
      <div className="import-actions">
        <button type="button" onClick={importFiles} disabled={!!running}>
          导入文件…
        </button>
        <button type="button" onClick={importFolder} disabled={!!running}>
          导入文件夹…
        </button>
        <button type="button" onClick={findEagle} disabled={!!running || lookingForEagle}>
          {lookingForEagle ? "正在查找 Eagle 资料库…" : "从 Eagle 迁入…"}
        </button>
      </div>
      {importError && <p role="alert">{importError}</p>}
      {eagleLibraries !== null && (
        <section className="import-report" aria-label="Eagle 首次迁入">
          <header>
            <span>{eagleLibraries.length ? "选择要迁入的 Eagle 资料库" : "没有自动找到可读的 Eagle 资料库"}</span>
            <button type="button" onClick={importFolder} disabled={!!running}>手动选择 Eagle 资料库…</button>
            <button type="button" onClick={() => setEagleLibraries(null)}>关闭</button>
          </header>
          <p>原图、标签、文件夹、来源链接与备注会迁入当前资料库，Eagle 原库保持不变。回收站中的图会进入可恢复删除；区域评论会保留，暂不显示。</p>
          <ul>
            {eagleLibraries.map((candidate) => (
              <li key={candidate.path}>
                <span>{candidate.name} · {candidate.items} 项{candidate.version && ` · Eagle ${candidate.version}`}</span>
                <span className="import-report-path">{candidate.path}</span>
                <button type="button" disabled={!!running} onClick={() => void begin([candidate.path])}>迁入 {candidate.name}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
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
            onClick={() => running.taskId && cancelImport(libraryId, running.taskId).catch((e) => alive.current && setImportError(`无法取消导入：${String(e)}`))}
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
