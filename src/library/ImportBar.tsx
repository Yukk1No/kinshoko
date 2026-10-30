import { SealedImportPreview } from "./SealedImportPreview";
import type { SaveDestination } from "../bindings/SaveDestination";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, Download, History, MapPinned, X } from "lucide-react";
import { SealLock } from "../ui/SealLock";
import type { ImportOptions } from "../bindings/ImportOptions";
import type { ImportProgress } from "../bindings/ImportProgress";
import type { ImportReport } from "../bindings/ImportReport";
import type { RecoveryReport } from "../bindings/RecoveryReport";
import type { EagleLibraryCandidate } from "../bindings/EagleLibraryCandidate";
import { EagleTagStep } from "./EagleTagStep";
import type { EagleLocationChoice } from "../bindings/EagleLocationChoice";
import type { EagleRelocation } from "../bindings/EagleRelocation";
import { cancelImport, confirmEagleLocation, discoverEagleLibraries, importContainsEagle, libraryRecovery, onFileDrop, pickFiles, pickFolder, startImport } from "../ipc";
import { EagleLibrariesDialog, ImportPlanDialog, ImportResultCard, type ImportPlan } from "./ImportBarParts";
import { useImportNotices } from "./useImportNotices";

export type RunningImport = { taskId: string | null; progress: ImportProgress; libraryId?:string; destination?:SaveDestination; libraryName?:string; folderName?:string };
/** 已结束的导入任务与它的报告。 */
export type FinishedImport = { taskId: string; report: ImportReport; libraryId?:string; destination?:SaveDestination; libraryName?:string; folderName?:string };

type Props = {
  enabled: boolean;
  previewContextKey?: string;
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
  /** 导入入口是顶栏的分体按钮（#98），经 `actionsRef` 调用这里的流程。 */
  actionsRef?: Ref<ImportActions>;
  /** 能否开始新的导入（与入口按钮的可用状态一致），以及是否正在查找 Eagle 资料库。 */
  onBusyChange?: (busy: boolean, lookingForEagle: boolean) => void;
  /** 导入确认对话框里的保存位置选择（图库 + 文件夹）。 */
  picker?: ReactNode;
  /** 进度卡与结果卡里的任务切换（同时有多个任务回执时）。 */
  taskSwitcher?: ReactNode;
  /** 卡片里的附加说明（任务警告、正在发布标签定义）。 */
  cardNotes?: ReactNode;
  /** 卡片上的保存位置，例如“角色参考 / 人物 / 发型”。 */
  ownerLabel?: string | null;
};

/** 导入入口（图片文件、整个文件夹、Eagle，以及已准备好的文件，如暂存的剪贴板图片）与找回任务卡片。 */
export type ImportActions = { files: () => void; folder: () => void; eagle: () => void; paths: (paths: string[]) => void; showTasks: () => void };


/**
 * 导入（#98）：选择文件或文件夹，或把它们拖进主窗口；先在对话框里选图库和文件夹（Eagle 另问删过的图），
 * 进度是右下角的卡片，可取消或后台进行。结束、出错、上次中断与封印项重复走轻提示（#388）；结束的提示带“查看”，
 * 打开结果回执卡：列出没有进来的文件并可只重试读取失败的项。没有 ToastProvider 时（单独渲染）这些仍是卡片。
 */
export function ImportBar({ previewContextKey, enabled, libraryId, libraryName, destination, destinationReady=true, running, finished, onStarted, onRetryDestination, onDismissReport, onOpenTrash, actionsRef, onBusyChange, picker, taskSwitcher, cardNotes, ownerLabel }: Props) {
  /** “后台进行”收起的进度卡（按任务 id）；新任务或从导入菜单“查看导入任务”时重新显示。 */
  const [background, setBackground] = useState<string | null>(null);
  const report = finished?.report ?? null;
  const contextKey = previewContextKey ?? libraryId;
  const [preview, setPreview] = useState<{ taskId: string; contextKey: string } | null>(null);
  useEffect(() => { setPreview(null); }, [finished?.taskId, contextKey, enabled]);
  const [hovering, setHovering] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryReport | null>(null);
  const [eagleLibraries, setEagleLibraries] = useState<EagleLibraryCandidate[] | null>(null);
  const [lookingForEagle, setLookingForEagle] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
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

  useImperativeHandle(actionsRef, () => ({
    files: () => { if (!busy) void importFiles(); },
    folder: () => { if (!busy) void importFolder(); },
    eagle: () => { if (!busy && !lookingForEagle) void findEagle(); },
    paths: (paths) => { if (!busy) void begin(paths); },
    showTasks: () => { setBackground(null); setReceipt(finished?.taskId ?? null); },
  }));
  useEffect(() => { onBusyChange?.(busy, lookingForEagle); }, [busy, lookingForEagle, onBusyChange]);

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
      if (alive.current) setImportError(`无法查找 Eagle 库：${String(error)}`);
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

  const { done = 0, total = 0 } = running?.progress ?? {};
  const relocations = (report?.eagleRelocations ?? []).filter((r) => !confirmed.includes(r.to));
  const confirm = async (relocation: EagleRelocation, choice: EagleLocationChoice) => {
    try {
      setImportError(null);
      await confirmEagleLocation(finished?.libraryId??libraryId, relocation.to, choice);
      if (!alive.current) return;
      setConfirmed((done) => [...done, relocation.to]);
      await begin([relocation.to], true, finished ? optionsByTask.current.get(finished.taskId) : undefined, finished?.destination);
    } catch (error) {
      if (alive.current) setImportError(`无法确认 Eagle 库的位置：${String(error)}`);
    }
  };
  const interrupted = recovery?.interrupted ?? [];
  const orphans = recovery?.orphans ?? [];

  const minimized = running !== null && background === (running.taskId ?? "");
  const owner = ownerLabel ?? (finished?.libraryName ? `${finished.libraryName} / ${finished.folderName ?? "未归类"}` : running?.libraryName ? `${running.libraryName} / ${running.folderName ?? "未归类"}` : null);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const sealed = report?.sealedDuplicates && finished;

  const { toast, receiptOpen, setReceipt } = useImportNotices({ finished, owner, recovery, setRecovery, importError, setImportError,
    reimport: (paths) => void latest.current.begin(paths), sealedTask: sealed ? sealed.taskId : null, showSealed: (taskId) => setPreview({ taskId, contextKey }) });

  const cards = <>
    {importError && <section className="k-task" role="alert" aria-label="导入出错">
      <div className="k-task-top"><CircleAlert size={16} className="k-task-icon is-error" aria-hidden="true" /><b>导入出错</b>
        <button type="button" className="k-icon-btn is-sm" aria-label="知道了" onClick={() => setImportError(null)}><X size={14} aria-hidden="true" /></button></div>
      <p className="k-task-sub">{importError}</p>
    </section>}
    {!toast && (interrupted.length > 0 || orphans.length > 0) && (
      <section className="k-task" role="status" aria-label={interrupted.length > 0 ? "上次导入中断" : "原文件夹里有不认识的文件"}>
        <div className="k-task-top"><History size={16} className="k-task-icon" aria-hidden="true" />
          <b>{interrupted.length > 0 ? "上次导入中断" : "有不认识的文件"}</b>
          <button type="button" className="k-icon-btn is-sm" aria-label="关闭" onClick={() => setRecovery(null)}><X size={14} aria-hidden="true" /></button></div>
        <p className="k-task-sub">
          {interrupted.length > 0 && `${interrupted.length} 个文件已撤回，没有留下半张图`}
          {interrupted.length > 0 && orphans.length > 0 && "；"}
          {orphans.length > 0 && `图库的原文件夹里有 ${orphans.length} 个不认识的文件，已保留`}
        </p>
        {interrupted.length > 0 && <details className="k-task-more"><summary>查看文件</summary><ul>
          {interrupted.map((path) => <li key={path}><span className="import-report-path">{path}</span></li>)}
        </ul></details>}
        {interrupted.length > 0 && <div className="k-task-acts">
          <button type="button" className="k-btn is-sm" aria-label="重新导入这些文件" disabled={busy} onClick={() => { void begin(interrupted); setRecovery(null); }}><span className="k-label">重新导入</span></button>
        </div>}
      </section>
    )}
    {relocations.map((relocation) => (
      <section key={relocation.to} className="k-task" role="alert" aria-label="Eagle 库换了位置？">
        <div className="k-task-top"><MapPinned size={16} className="k-task-icon" aria-hidden="true" /><b>Eagle 库换了位置？</b></div>
        <p className="k-task-sub">这里有 {relocation.overlapPercent}% 的图已经从另一个位置导入过。确认前不会导入任何内容。</p>
        <p className="k-task-sub import-report-path">新位置：{relocation.to}</p>
        <p className="k-task-sub import-report-path">原位置：{relocation.from}</p>
        <div className="k-task-acts">
          <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void confirm(relocation, { kind: "moved", sourceId: relocation.sourceId })}><span className="k-label">是同一个库</span></button>
          <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void confirm(relocation, { kind: "separate" })}><span className="k-label">是另一个库</span></button>
        </div>
      </section>
    ))}
    {running && !minimized && (
      <section className="k-task" aria-label="导入进度">
        <div className="k-task-top"><Download size={16} className="k-task-icon is-accent" aria-hidden="true" /><b>正在导入</b>
          <span className="k-task-count tabular">{done} / {total}</span></div>
        {owner && <p className="k-task-sub">放到 {owner}</p>}
        {taskSwitcher}
        <progress className="k-task-progress" max={Math.max(total, 1)} value={done} aria-label="导入进度"
          aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} style={{ ["--p" as string]: `${percent}%` }} />
        {cardNotes}
        <div className="k-task-acts">
          <button type="button" className="k-btn is-sm" aria-label="取消导入" disabled={!running.taskId}
            onClick={() => running.taskId && cancelImport(running.libraryId??libraryId, running.taskId).catch((e) => alive.current && setImportError(`无法取消导入：${String(e)}`))}><span className="k-label">取消</span></button>
          <button type="button" className="k-btn is-sm is-ghost" onClick={() => setBackground(running.taskId ?? "")}><span className="k-label">后台进行</span></button>
        </div>
      </section>
    )}
    {report && receiptOpen && (
      <ImportResultCard report={report} finished={finished} owner={owner} taskSwitcher={taskSwitcher} cardNotes={cardNotes} busy={busy}
        begin={begin} optionsByTask={optionsByTask} libraryId={libraryId} onOpenTrash={onOpenTrash} onDismissReport={() => { setReceipt(null); onDismissReport(); }} />
    )}
    {!toast && sealed && <section className="k-task is-row sealed-import-prompt" aria-label="封印项重复">
      {/* #78 规定的原文：不点名内容类别，不给数量。 */}
      <SealLock size={10} /><span className="k-grow">有封印项重复，是否展开看看</span>
      <button type="button" className="k-btn is-sm" aria-label="展开本次重复项" onClick={() => setPreview({ taskId: sealed.taskId, contextKey })}><span className="k-label">展开</span></button>
    </section>}
  </>;

  return (
    <div className="import-bar">
      {/* 右下角的进度与结果卡片挂在 body 上。 */}
      {createPortal(<div className="k-task-cards">{cards}</div>, document.body)}
      <ImportPlanDialog plan={plan} setPlan={setPlan} preparing={preparing} running={running} destinationReady={destinationReady} startPlan={startPlan} picker={picker} />
      <EagleLibrariesDialog eagleLibraries={eagleLibraries} setEagleLibraries={setEagleLibraries} busy={busy} begin={begin} importFolder={importFolder} />
      {hovering && (
        <div className="drop-hint k-drop-hint" aria-live="polite">
          {destination === null ? "松开即可导入，再选放在哪里" : `松开即可导入到 ${libraryName}`}
        </div>
      )}
      {finished && preview?.taskId === finished.taskId && preview.contextKey === contextKey && enabled && <SealedImportPreview key={finished.taskId} libraryId={finished.libraryId ?? libraryId} taskId={finished.taskId} onClose={() => setPreview(null)} />}
      <Dialog.Root open={tagStep} onOpenChange={(open) => { if (!open) setTagStep(false); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          <Dialog.Popup className="k-dialog k-import-dialog is-wide" aria-label="补上标签对应">
            {tagStep && <EagleTagStep libraryId={finished?.libraryId??libraryId} onClose={() => setTagStep(false)} />}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
