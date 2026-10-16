import { SealedImportPreview } from "./SealedImportPreview";
import type { SaveDestination } from "../bindings/SaveDestination";
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@base-ui/react/dialog";
import { CircleAlert, CircleCheck, CircleSlash, Download, FolderOpen, History, Images, Library, MapPinned, X } from "lucide-react";
import { SealLock } from "../ui/SealLock";
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

/** 三个导入入口（图片文件、整个文件夹、Eagle）与找回任务卡片。 */
export type ImportActions = { files: () => void; folder: () => void; eagle: () => void; showTasks: () => void };

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
 * 导入（#98）：选择文件或文件夹，或把它们拖进主窗口；先在对话框里选图库和文件夹（Eagle 另问删过的图），
 * 进度与结果是右下角的卡片：进行中可取消或后台进行，结束后列出没有进来的文件并可只重试读取失败的项。
 * 打开图库时若上次导入中断，提示撤回了哪些文件。
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

  useImperativeHandle(actionsRef, () => ({
    files: () => { if (!busy) void importFiles(); },
    folder: () => { if (!busy) void importFolder(); },
    eagle: () => { if (!busy && !lookingForEagle) void findEagle(); },
    showTasks: () => setBackground(null),
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
      if (alive.current) setImportError(`无法确认 Eagle 库的位置：${String(error)}`);
    }
  };
  const interrupted = recovery?.interrupted ?? [];
  const orphans = recovery?.orphans ?? [];

  const minimized = running !== null && background === (running.taskId ?? "");
  const owner = ownerLabel ?? (finished?.libraryName ? `${finished.libraryName} / ${finished.folderName ?? "未归类"}` : running?.libraryName ? `${running.libraryName} / ${running.folderName ?? "未归类"}` : null);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const sealed = report?.sealedDuplicates && finished;

  const cards = <>
    {importError && <section className="k-task" role="alert" aria-label="导入出错">
      <div className="k-task-top"><CircleAlert size={16} className="k-task-icon is-error" aria-hidden="true" /><b>导入出错</b>
        <button type="button" className="k-icon-btn is-sm" aria-label="知道了" onClick={() => setImportError(null)}><X size={14} aria-hidden="true" /></button></div>
      <p className="k-task-sub">{importError}</p>
    </section>}
    {(interrupted.length > 0 || orphans.length > 0) && (
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
          <button type="button" className="k-btn is-sm" aria-label="重新导入这些文件" disabled={busy} onClick={() => { void begin(interrupted); setRecovery(null); }}>重新导入</button>
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
          <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void confirm(relocation, { kind: "moved", sourceId: relocation.sourceId })}>是同一个库</button>
          <button type="button" className="k-btn is-sm" disabled={busy} onClick={() => void confirm(relocation, { kind: "separate" })}>是另一个库</button>
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
            onClick={() => running.taskId && cancelImport(running.libraryId??libraryId, running.taskId).catch((e) => alive.current && setImportError(`无法取消导入：${String(e)}`))}>取消</button>
          <button type="button" className="k-btn is-sm is-ghost" onClick={() => setBackground(running.taskId ?? "")}>后台进行</button>
        </div>
      </section>
    )}
    {report && counts && (
      <section className="k-task" aria-label="导入结果">
        <div className="k-task-top">
          {report.cancelled ? <CircleSlash size={16} className="k-task-icon" aria-hidden="true" /> : <CircleCheck size={16} className="k-task-icon is-ok" aria-hidden="true" />}
          <b>{report.cancelled ? "导入已取消" : "导入完成"}</b>
          <button type="button" className="k-icon-btn is-sm" aria-label="关闭导入结果" onClick={onDismissReport}><X size={14} aria-hidden="true" /></button>
        </div>
        {owner && <p className="k-task-sub">放到 {owner}</p>}
        {taskSwitcher}
        {report.privateSummary ? <p className="k-task-sub">内容处理结果已保留</p> : <p className="k-task-stats">
          <span>新增 <b>{counts.imported}</b></span>
          {counts.merged > 0 && <span title="与已有的图相同，已合并">已存在 <b>{counts.merged}</b></span>}
          {counts.refreshed > 0 && <span title="更新了 Eagle 信息，本库的整理保留">更新 <b>{counts.refreshed}</b></span>}
          {counts.newVersions > 0 && <span title="Eagle 里内容变了，作为新版本进库，旧版本保留">新版本 <b>{counts.newVersions}</b></span>}
          {report.eagleMissing > 0 && <span title="Eagle 里已经没有，本库保留">Eagle 已删 <b>{report.eagleMissing}</b></span>}
        </p>}
        {counts.rejected.length > 0 && <p className="k-task-stats"><span className="is-danger">没导入 <b>{counts.rejected.length}</b></span></p>}
        {cardNotes}
        {counts.skippedDeleted.length > 0 && <p className="k-task-sub">删过的图已跳过。
          <button type="button" className="k-link" disabled={busy} onClick={() => void begin(counts.skippedDeleted, true, undefined, finished?.destination)}>这次也导入…</button></p>}
        {(counts.trashDuplicate || report.trashDuplicates) && <p className="k-task-sub">有图在回收站里，保持删除。
          {onOpenTrash && <button type="button" className="k-link" onClick={()=>onOpenTrash?.(finished?.libraryId??libraryId)}>去回收站</button>}</p>}
        {counts.rejected.length > 0 && <details className="k-task-more"><summary>没导入的文件</summary><ul>
          {counts.rejected.map((item) => <li key={item.path}><span className="import-report-path">{item.path}</span><span className="import-report-reason">{reason(item.outcome)}</span></li>)}
        </ul></details>}
        {counts.failed.length > 0 && <div className="k-task-acts">
          <button type="button" className="k-btn is-sm" aria-label={`重试失败的 ${counts.failed.length} 项`} disabled={busy}
            onClick={() => void begin(counts.failed, false, finished ? optionsByTask.current.get(finished.taskId) : undefined, finished?.destination)}>重试失败</button>
        </div>}
      </section>
    )}
    {sealed && <section className="k-task is-row sealed-import-prompt" aria-label="封印项重复">
      {/* #78 规定的原文：不点名内容类别，不给数量。 */}
      <SealLock size={10} /><span className="k-grow">有封印项重复，是否展开看看</span>
      <button type="button" className="k-btn is-sm" aria-label="展开本次重复项" onClick={() => setPreview({ taskId: sealed.taskId, contextKey })}>展开</button>
    </section>}
  </>;

  return (
    <div className="import-bar">
      {/* 右下角的进度与结果卡片挂在 body 上。 */}
      {createPortal(<div className="k-task-cards">{cards}</div>, document.body)}
      <Dialog.Root open={plan !== null} onOpenChange={(open) => { if (!open && !preparing) setPlan(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          {/* Popup 留在 Root 下，只让内容随状态出现：卸下 Popup 会让关闭动画等不到结束，遮罩留下盖住窗口（#98 本机 r12）。 */}
          <Dialog.Popup className="k-dialog k-import-dialog">{plan && <>
            <Dialog.Title className="k-dialog-title">{plan.eagle ? "从 Eagle 导入" : "导入图片"}</Dialog.Title>
            <Dialog.Description className="k-dialog-desc">{plan.eagle ? "原库不会改动。" : "选好放在哪里，就能开始。"}</Dialog.Description>
            <div className="k-import-summary">
              <span className="k-big-tag-icon" aria-hidden="true">{plan.eagle ? <Library size={18} /> : <Images size={18} />}</span>
              <div className="k-list-text">
                <div className="k-list-title">{plan.paths.length === 1 ? baseName(plan.paths[0]) : `${plan.paths.length} 个文件或文件夹`}</div>
                <details className="k-task-more"><summary>来自</summary><ul>{plan.paths.map((path) => <li key={path}><span className="import-report-path">{path}</span></li>)}</ul></details>
              </div>
            </div>
            {picker}
            {plan.eagle && <fieldset className="k-fieldset" disabled={preparing || !!running}>
              <legend className="k-field-label">删过的图</legend>
              <div className="k-radio-cards">
                {([["skipDeleted", "继续跳过", "之前删掉的不再导入"], ["allowThisImport", "这次也导入", "只对这一次有效"]] as const).map(([value, title, desc]) =>
                  <label key={value} className={`k-radio-card${plan.options.eagleDeletedContent === value ? " is-on" : ""}`}>
                    <input type="radio" name="eagle-deleted-content" checked={plan.options.eagleDeletedContent === value}
                      onChange={() => setPlan({ ...plan, options: { eagleDeletedContent: value } })} />
                    <span><span className="k-radio-title">{title}</span><span className="k-radio-desc">{desc}</span></span>
                  </label>)}
              </div>
              <p className="k-set-note">新版本照常导入；回收站里的重复项保持删除。</p>
            </fieldset>}
            <div className="k-dialog-foot">
              <span className="k-grow" />
              <button type="button" className="k-btn" disabled={preparing} onClick={() => setPlan(null)}>取消</button>
              <button type="button" className="k-btn is-primary" disabled={preparing || !!running || !destinationReady} onClick={() => void startPlan()}>开始导入</button>
            </div>
          </>}</Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={eagleLibraries !== null} onOpenChange={(open) => { if (!open) setEagleLibraries(null); }}>
        <Dialog.Portal>
          <Dialog.Backdrop className="k-backdrop" />
          <Dialog.Popup className="k-dialog k-import-dialog">{eagleLibraries && <>
            <Dialog.Title className="k-dialog-title">从 Eagle 导入</Dialog.Title>
            <Dialog.Description className="k-dialog-desc">原库不变；标签、文件夹、备注都带来。</Dialog.Description>
            {eagleLibraries.length ? <ul className="k-list" aria-label="找到的 Eagle 库">
              {eagleLibraries.map((candidate) => <li key={candidate.path} className="k-list-row">
                <span className="k-list-icon" aria-hidden="true"><Library size={16} /></span>
                <div className="k-list-text">
                  <div className="k-list-title">{candidate.name}</div>
                  <p className="k-list-desc" title={candidate.path}>{candidate.items} 张{candidate.version && ` · Eagle ${candidate.version}`} · {candidate.path}</p>
                </div>
                <div className="k-list-end"><button type="button" className="k-btn is-sm" aria-label={`导入 ${candidate.name}`} disabled={busy} onClick={() => { setEagleLibraries(null); void begin([candidate.path], true); }}>导入</button></div>
              </li>)}
            </ul> : <p className="k-set-note" role="status">没有自动找到 Eagle 库，可以手动选择。</p>}
            <p className="k-set-note">回收站里的图会进入可恢复的删除；区域评论会保留，暂不显示。</p>
            <div className="k-dialog-foot">
              <button type="button" className="k-btn" disabled={busy} onClick={() => { setEagleLibraries(null); void importFolder(true); }}><FolderOpen size={14} aria-hidden="true" />手动选择…</button>
              <span className="k-grow" />
              <button type="button" className="k-btn" onClick={() => setEagleLibraries(null)}>取消</button>
            </div>
          </>}</Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
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

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
