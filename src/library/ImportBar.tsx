import { SealedImportPreview } from "./SealedImportPreview";
import type { SaveDestination } from "../bindings/SaveDestination";
import { useEffect, useRef, useState } from "react";
import type { ImportOptions } from "../bindings/ImportOptions";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportReport } from "../bindings/ImportReport";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import type { EagleLibraryCandidate } from "../bindings/EagleLibraryCandidate";
import { EagleTagStep } from "./EagleTagStep";
import type { EagleLocationChoice } from "../bindings/EagleLocationChoice";
import type { EagleRelocation } from "../bindings/EagleRelocation";
import { cancelImport, confirmEagleLocation, discoverEagleLibraries, importContainsEagle, libraryRecovery, onFileDrop, pickFiles, pickFolder, startImport } from "../ipc";

export type RunningImport = { taskId: string | null; progress: ImportProgress; libraryId?:string; destination?:SaveDestination; libraryName?:string; folderName?:string };
/** 已结束的导入任务与它的报告。 */
export type FinishedImport = { taskId: string; report: ImportReport; libraryId?:string; destination?:SaveDestination; libraryName?:string; folderName?:string };

type Props = {
  enabled: boolean;
  previewContextActive?: boolean;
  libraryId: string;
  libraryName: string;
  destination?:SaveDestination|null;
  destinationReady?:boolean;
  running: RunningImport | null;
  finished: FinishedImport | null;
  onStarted: (taskId: string, destination?:SaveDestination) => void;
  onRetryDestination?: (destination:SaveDestination)=>void;
  onDismissReport: () => void;
  /** 到现有、受安全模式筛选的回收站，由画师决定恢复。 */
  onOpenTrash?: (libraryId?:string) => void;
  /** 紧凑导入菜单需要展示待确认选择或通知时展开。 */
  onShowRequested?: () => void;
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
export function ImportBar({ previewContextActive=true, enabled, libraryId, libraryName, destination, destinationReady=true, running, finished, onStarted, onRetryDestination, onDismissReport, onOpenTrash, onShowRequested }: Props) {
  const report = finished?.report ?? null;
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => { setPreview(null); }, [finished?.taskId, previewContextActive, enabled]);
  const [hovering, setHovering] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [eagleLibraries, setEagleLibraries] = useState<EagleLibraryCandidate[] | null>(null);
  const [lookingForEagle, setLookingForEagle] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [plan, setPlan] = useState<{ paths: string[]; options: ImportOptions; eagle:boolean } | null>(null);
  const optionsByTask = useRef(new Map<string, ImportOptions>());
  const busy = !!running || preparing || plan !== null;
  /**
   * 从 Eagle 迁入的任务 id；它结束后进入“标签的外部对应”一步。结束事件可能先于启动命令的
   * 响应到达，所以按 task id 把来源与终态对上，哪个先到都只打开一次（#77 UI-E）。
   */
  const [eagleTasks, setEagleTasks] = useState<ReadonlySet<string>>(() => new Set());
  const stepShown = useRef(new Set<string>());
  const [tagStep, setTagStep] = useState(false);
  // 已确认过的搬家提议，不再重复询问。
  const [confirmed, setConfirmed] = useState<string[]>([]);
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

  const start = async (paths: string[], fromEagle = false, options?: ImportOptions, fixed?:SaveDestination) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    try {
      setImportError(null);
      setTagStep(false);
      const taskId = await startImport(fixed?.libraryId??libraryId, paths, options, fixed??destination??undefined);
      if (!alive.current) return;
      if (options) optionsByTask.current.set(taskId, options);
      if (fromEagle) setEagleTasks((tasks) => new Set(tasks).add(taskId));
      onStarted(taskId,fixed??destination??{libraryId,folderId:null});
      setPlan(null);
      setEagleLibraries(null);
    } catch (error) {
      if (alive.current) setImportError(`无法开始导入：${String(error)}`);
    }
  };
  // 手选、拖入、恢复中断与失败重试都经过同一只读预检；取消选择不会启动任务或写入来源。
  const begin = async (paths: string[], fromEagle = false, options?: ImportOptions, fixed?:SaveDestination) => {
    if (!alive.current || !enabledRef.current || !paths.length) return;
    if(fixed)onRetryDestination?.(fixed);
    setPreparing(true);
    setImportError(null);
    try {
      const isEagle = fromEagle || await importContainsEagle(paths);
      if (!alive.current || !enabledRef.current) return;
      if (isEagle || destination !== undefined) {
        setPlan({ paths, options: options ?? { eagleDeletedContent: "skipDeleted" }, eagle:isEagle });
      } else {
        await start(paths, false, options, fixed);
      }
    } catch (error) {
      if (alive.current) setImportError(`无法检查导入来源：${String(error)}`);
    } finally {
      if (alive.current) setPreparing(false);
    }
  };
  const startPlan = async () => {
    if (!plan || running || preparing || !destinationReady) return;
    setPreparing(true);
    await start(plan.paths, plan.eagle, plan.options, destination??undefined);
    if (alive.current) setPreparing(false);
  };
  const importFiles = async () => begin(await pickFiles());
  const importFolder = async (fromEagle = false) => {
    const folder = await pickFolder();
    await begin(folder ? [folder] : [], fromEagle);
  };

  const finishedTask = finished?.taskId ?? null;
  const detectedEagle = finished?.report.fromEagle ?? false;
  useEffect(() => {
    if (finishedTask === null || (!detectedEagle && !eagleTasks.has(finishedTask)) || stepShown.current.has(finishedTask)) return;
    stepShown.current.add(finishedTask);
    setTagStep(true);
  }, [finishedTask, detectedEagle, eagleTasks]);
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
  const latest = useRef({ busy, begin });
  latest.current = { busy, begin };
  useEffect(() => {
    const unlisten = onFileDrop((drop) => {
      if (!alive.current || !enabledRef.current) return;
      switch (drop.kind) {
        case "enter":
          setHovering(!latest.current.busy);
          break;
        case "drop":
          setHovering(false);
          if (!latest.current.busy) void latest.current.begin(drop.paths);
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

  useEffect(() => {
    if (hovering || plan || (recovery && (recovery.interrupted.length > 0 || recovery.orphans.length > 0))) onShowRequested?.();
  }, [hovering, plan, recovery, onShowRequested]);

  const { done = 0, total = 0 } = running?.progress ?? {};
  const counts = report && {
    imported: report.items.filter((i) => i.outcome.kind === "imported").length,
    merged: report.items.filter((i) => i.outcome.kind === "merged").length,
    refreshed: report.items.filter((i) => i.outcome.kind === "refreshed").length,
    newVersions: report.items.filter((i) => i.outcome.kind === "newVersion").length,
    skippedDeleted: report.items.filter((i) => i.outcome.kind === "skippedDeleted").map((i) => i.path),
    trashDuplicate: report.items.some((i) => i.outcome.kind === "trashDuplicate"),
    rejected: report.items.filter((i) => reason(i.outcome) !== null),
    failed: report.items.filter((i) => i.outcome.kind === "readFailed").map((i) => i.path),
  };
  const relocations = (report?.eagleRelocations ?? []).filter((r) => !confirmed.includes(r.to));
  const confirm = async (relocation: EagleRelocation, choice: EagleLocationChoice) => {
    try {
      setImportError(null);
      await confirmEagleLocation(finished?.libraryId??libraryId, relocation.to, choice);
      if (!alive.current) return;
      setConfirmed((done) => [...done, relocation.to]);
      await begin([relocation.to], true, finished ? optionsByTask.current.get(finished.taskId) : undefined, finished?.destination);
    } catch (error) {
      if (alive.current) setImportError(`无法确认 Eagle 资料库的位置：${String(error)}`);
    }
  };
  const interrupted = recovery?.interrupted ?? [];
  const orphans = recovery?.orphans ?? [];

  return (
    <div className="import-bar">
      <div className="import-actions">
        <button type="button" onClick={importFiles} disabled={busy}>
          导入文件…
        </button>
        <button type="button" onClick={() => void importFolder()} disabled={busy}>
          导入文件夹…
        </button>
        <button type="button" onClick={findEagle} disabled={busy || lookingForEagle}>
          {lookingForEagle ? "正在查找 Eagle 资料库…" : "从 Eagle 迁入…"}
        </button>
      </div>
      {importError && <p role="alert">{importError}</p>}
      {plan && (
        <section className="import-report" aria-label={plan.eagle?"Eagle 重导选择":"导入确认"}>
          <header><span>导入到 {libraryName}</span></header>
          {plan.eagle&&<><p>选择本次如何处理曾永久删除的同一内容。新内容版本仍可导入；回收站重复项保持删除状态。</p>
          <fieldset disabled={preparing || !!running}>
            <legend>永久删除的内容</legend>
            <label>
              <input type="radio" name="eagle-deleted-content" checked={plan.options.eagleDeletedContent === "skipDeleted"}
                onChange={() => setPlan({ ...plan, options: { eagleDeletedContent: "skipDeleted" } })} />
              记住永久删除，跳过同一内容（默认）
            </label>
            <label>
              <input type="radio" name="eagle-deleted-content" checked={plan.options.eagleDeletedContent === "allowThisImport"}
                onChange={() => setPlan({ ...plan, options: { eagleDeletedContent: "allowThisImport" } })} />
              允许本次重新导入永久删除的内容
            </label>
          </fieldset>
          <p>选择只用于这次任务，之后仍默认记住删除决定。</p></>}
          <ul>{plan.paths.map((path) => <li key={path}><span className="import-report-path">{path}</span></li>)}</ul>
          <div className="import-actions">
            <button type="button" disabled={preparing || !!running || !destinationReady} onClick={() => void startPlan()}>{plan.eagle?"开始 Eagle 导入":"开始导入"}</button>
            <button type="button" disabled={preparing} onClick={() => setPlan(null)}>取消</button>
          </div>
        </section>
      )}
      {eagleLibraries !== null && (
        <section className="import-report" aria-label="Eagle 首次迁入">
          <header>
            <span>{eagleLibraries.length ? "选择要迁入的 Eagle 资料库" : "没有自动找到可读的 Eagle 资料库"}</span>
            <button type="button" onClick={() => void importFolder(true)} disabled={busy}>手动选择 Eagle 资料库…</button>
            <button type="button" onClick={() => setEagleLibraries(null)}>关闭</button>
          </header>
          <p>原图、标签、文件夹、来源链接与备注会迁入所选保存位置，Eagle 原库保持不变。回收站中的图会进入可恢复删除；区域评论会保留，暂不显示。</p>
          <ul>
            {eagleLibraries.map((candidate) => (
              <li key={candidate.path}>
                <span>{candidate.name} · {candidate.items} 项{candidate.version && ` · Eagle ${candidate.version}`}</span>
                <span className="import-report-path">{candidate.path}</span>
                <button type="button" disabled={busy} onClick={() => void begin([candidate.path], true)}>迁入 {candidate.name}</button>
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
            onClick={() => running.taskId && cancelImport(running.libraryId??libraryId, running.taskId).catch((e) => alive.current && setImportError(`无法取消导入：${String(e)}`))}
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
                disabled={busy}
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
      {relocations.map((relocation) => (
        <section key={relocation.to} className="import-report" role="alert" aria-label="Eagle 资料库换了位置？">
          <header>
            <span>
              这个 Eagle 资料库里有 {relocation.overlapPercent}% 的条目已经从另一个位置迁入过。是同一个资料库搬了家吗？确认前不会迁入任何内容。
            </span>
          </header>
          <p className="import-report-path">新位置：{relocation.to}</p>
          <p className="import-report-path">原位置：{relocation.from}</p>
          <div className="import-actions">
            <button type="button" disabled={busy} onClick={() => void confirm(relocation, { kind: "moved", sourceId: relocation.sourceId })}>
              是搬了家，按原来源重导
            </button>
            <button type="button" disabled={busy} onClick={() => void confirm(relocation, { kind: "separate" })}>
              是另一个资料库，单独迁入
            </button>
          </div>
        </section>
      ))}
      {report && counts && (
        <section className="import-report" aria-label="导入结果">
          <header>
            <span>
              {report.cancelled ? "导入已取消" : "导入完成"}{report.privateSummary ? "，内容处理结果已保留" : <>：新增 {counts.imported} 张
              {counts.merged > 0 && `，与已有图相同而合并 ${counts.merged} 张`}
              {counts.refreshed > 0 && `，更新 Eagle 信息 ${counts.refreshed} 张（本库整理保留）`}
              {counts.newVersions > 0 && `，Eagle 中内容变了的 ${counts.newVersions} 张作为新版本进库（旧版本保留）`}
              {report.eagleMissing > 0 && `；Eagle 中已不存在的 ${report.eagleMissing} 张在本库保留`}</>}
              {counts.rejected.length > 0 && `，${counts.rejected.length} 个文件没有导入`}
            </span>
            {counts.failed.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void begin(counts.failed, false, finished ? optionsByTask.current.get(finished.taskId) : undefined, finished?.destination)}>
                重试失败的 {counts.failed.length} 项
              </button>
            )}
            <button type="button" onClick={onDismissReport}>
              关闭
            </button>
          </header>
          {report.sealedDuplicates && <p className="sealed-import-prompt"><span>有封印项重复，是否展开看看</span>
            <button type="button" onClick={() => finished && setPreview(finished.taskId)}>展开本次重复项</button></p>}
          {counts.skippedDeleted.length > 0 && (
            <p>曾永久删除的同一内容已跳过。
              <button type="button" disabled={busy} onClick={() => void begin(counts.skippedDeleted, true, undefined, finished?.destination)}>重新选择永久删除重导策略…</button>
            </p>
          )}
          {(counts.trashDuplicate || report.trashDuplicates) && (
            <p>有内容与回收站重复，已保持删除状态。
              {onOpenTrash && <button type="button" onClick={()=>onOpenTrash?.(finished?.libraryId??libraryId)}>前往回收站恢复</button>}
            </p>
          )}
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
      {finished && preview === finished.taskId && previewContextActive && enabled && <SealedImportPreview key={finished.taskId} libraryId={finished.libraryId ?? libraryId} taskId={finished.taskId} onClose={() => setPreview(null)} />}
      {tagStep && <EagleTagStep libraryId={finished?.libraryId??libraryId} onClose={() => setTagStep(false)} />}
    </div>
  );
}
