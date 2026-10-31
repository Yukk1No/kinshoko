import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Popover } from "@base-ui/react/popover";
import { Download, FileImage, FolderOpen } from "lucide-react";
import type { SaveDestination } from "../../bindings/SaveDestination";
import type { WorkspaceScope } from "../../bindings/WorkspaceScope";
import { cancelImport, revealImportSource, stageClipboardImport } from "../../ipc";
import { destinationAvailable, folderChoices, SaveDestinationPicker, useSaveDestination } from "../SaveDestination";
import { SealedImportPreview } from "../SealedImportPreview";
import { EagleLibrariesDialog, ImportPlanDialog, RelocationDialog, TagStepDialog } from "./ImportDialogs";
import { ReceiptRow, RecoveryRow, RunningRow } from "./ImportTaskRows";
import { importCounts, type FinishedImport, type ImportTask, type RunningImport } from "./report";
import { useImportFlow } from "./useImportFlow";
import { useImportNotices } from "./useImportNotices";
import { useImportTaskList } from "./useImportTaskList";

/**
 * 从别处（图片墙右键菜单、Ctrl O）开始导入的入口。clipboard：把剪贴板里的图片暂存成文件，再走同一导入流程
 * （保存位置照常选择）；剪贴板没有图片或正在导入时 reject 中文原因（#105）。
 */
export type ImportControl = { files: () => void; folder: () => void; eagle: () => void; clipboard: () => Promise<void> };

/** Eagle has no lucide icon; a small line mark in the same weight. */
const EagleMark = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14c4-1 6-4 9-9 1 4 3 6 9 7-4 1-7 3-9 8-1-3-4-5-9-6Z" /></svg>;

/** 按钮上的进度环：日间樱、夜间金（--accent）；没有进度（收尾、刚开始）时整圈慢慢明暗。 */
function Ring({ done, total }: { done: number; total: number }) {
  const pending = total === 0 || done >= total;
  return <svg className="k-import-ring" viewBox="0 0 26 26" aria-hidden="true" data-pending={pending || undefined}>
    <circle className="k-import-ring-track" cx="13" cy="13" r="11.5" />
    {!pending && <circle className="k-import-ring-arc" cx="13" cy="13" r="11.5" pathLength={100} strokeDasharray={`${Math.round((done / total) * 100)} 100`} />}
  </svg>;
}

/**
 * 导入（#98、#388 重设计）：顶栏一个无底按钮，点开是一个弹层：上半选来源（图片 Ctrl O / 文件夹 / 从 Eagle 导入），
 * 下半是导入任务：进行中的进度与取消，已结束的回执（展开看数字与要处理的事），上次中断的文件。按钮在导入中带进度环，
 * 有没看过的未导入或提醒时挂点。结束与出错只发轻提示，“查看”打开弹层里的那条；导入前要回答的问题是对话框。
 */
export function ImportCenter({ control, scope, enabled, libraryId, running, finished, onStarted, onDismissReport, onOpenTrash }: {
  control?: Ref<ImportControl>; scope?: WorkspaceScope; enabled: boolean; libraryId: string;
  running: RunningImport | null; finished: FinishedImport | null;
  onStarted: (taskId: string, destination?: SaveDestination) => void; onDismissReport: () => void;
  /** 到现有、受安全模式筛选的回收站，由画师决定恢复。 */
  onOpenTrash?: (libraryId?: string) => void;
}) {
  const context = useSaveDestination();
  const list = useImportTaskList({ running, finished, onDismissReport });
  const runningTasks = list.tasks.filter((task) => task.report === null || task.finishing);
  const doneTasks = list.tasks.filter((task) => task.report !== null && !task.finishing).reverse();
  const active = runningTasks.length > 0 || list.pending !== null;
  const destinationLibrary = context.destination?.libraryId ?? "";
  const flow = useImportFlow({
    enabled, libraryId: destinationLibrary, destination: context.destination,
    destinationReady: context.ready && destinationAvailable(context.destination, context.providers), busyElsewhere: active,
    onRetryDestination: context.setDestination,
    onStarted: (taskId, destination) => {
      const provider = context.providers.find((p) => p.registration.library.id === destination.libraryId);
      const folderName = destination.folderId === null ? "未归类" : folderChoices(provider?.sidebar?.folders ?? []).find((f) => f.id === destination.folderId)?.path ?? "目标文件夹不可用";
      list.started(taskId, destination, provider?.registration.library.name ?? destination.libraryId, folderName);
      onStarted(taskId, destination);
    },
  });

  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 在弹层里展开看过的任务：按钮上的点不再为它亮。 */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [showRecovery, setShowRecovery] = useState(true);
  useEffect(() => { setShowRecovery(true); }, [flow.recovery]);
  const recovery = showRecovery && flow.recovery && (flow.recovery.interrupted.length > 0 || flow.recovery.orphans.length > 0) ? flow.recovery : null;

  const expand = (key: string | null) => {
    setExpanded(key);
    if (key !== null && key !== "recovery") { setSeen((previous) => new Set(previous).add(key)); notices.seen(key); }
  };
  const notices = useImportNotices({ tasks: list.tasks, error: flow.error, clearError: flow.clearError, recovery: flow.recovery,
    view: (taskId) => { setOpen(true); expand(taskId ?? "recovery"); } });

  // 点：没看过的未导入（红），否则没看过的提醒（金）。
  const unseen = doneTasks.filter((task) => !seen.has(task.taskId));
  const dot = unseen.some((task) => importCounts(task.report!).rejected.length > 0) ? "danger" : unseen.some((task) => task.warnings.length > 0) ? "warn" : null;
  const progress = runningTasks[0]?.progress ?? list.pending?.progress ?? null;

  // Eagle 迁入结束后的标签对应：最新结束的一条，结束事件与启动响应哪个先到都只打开一次（#77 UI-E）。
  const [tagStep, setTagStep] = useState<string | null>(null);
  const stepShown = useRef(new Set<string>());
  const newest = doneTasks[0];
  const newestEagle = newest && (newest.report!.fromEagle || flow.eagleTasks.has(newest.taskId)) ? newest : null;
  useEffect(() => {
    if (!newestEagle || stepShown.current.has(newestEagle.taskId)) return;
    stepShown.current.add(newestEagle.taskId);
    setTagStep(newestEagle.destination?.libraryId ?? destinationLibrary);
  }, [newestEagle?.taskId]);

  // 导入前要回答的问题：结束的 Eagle 任务里疑似搬了家的位置。
  const question = doneTasks.flatMap((task) => task.report!.eagleRelocations.filter((r) => !flow.confirmed.includes(r.to)).map((relocation) => ({ task, relocation })))[0] ?? null;
  const [answering, setAnswering] = useState(false);

  const [preview, setPreview] = useState<{ libraryId: string; taskId: string } | null>(null);
  // 封印重复项的展开只对当时那次同意有效：停用或换了当前图库立即遮回，回来也要再点一次（#78）。
  useEffect(() => { setPreview(null); }, [enabled, libraryId]);
  const reveal = (path: string) => void revealImportSource(path).catch((e) => notices.toast?.error(String(e)));
  const cancel = (task: ImportTask) => void cancelImport(task.destination?.libraryId ?? destinationLibrary, task.taskId).catch((e) => notices.toast?.error(`无法取消导入：${String(e)}`));

  // 在文件夹里浏览时，导入默认放进这个文件夹。
  const prefill = () => { if (scope?.kind === "library" && (scope.scope.kind === "folder" || scope.scope.kind === "folderTree")) context.setDestination({ libraryId: scope.libraryId, folderId: scope.scope.id }); };
  const via = (action: () => unknown) => () => { if (flow.busy) return; setOpen(false); prefill(); void action(); };
  useImperativeHandle(control, () => ({
    files: via(flow.files), folder: via(() => flow.folder()), eagle: () => { if (!flow.lookingForEagle) via(flow.findEagle)(); },
    clipboard: async () => {
      if (flow.busy) throw "正在导入，结束后再从剪贴板导入";
      const path = await stageClipboardImport();
      prefill(); void flow.begin([path]);
    },
  }));

  const label = active ? "正在导入" : "导入";
  return <div className="import-menu">
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger className="k-import" aria-label={label} title={dot === "danger" ? "导入：有未导入的文件" : dot === "warn" ? "导入：有提醒" : label} aria-busy={active || undefined}>
        <span className="k-import-glyph" data-busy={progress ? true : undefined}>
          {progress && <Ring done={progress.done} total={progress.total} />}
          <Download size={progress ? 13 : 18} strokeWidth={1.75} aria-hidden="true" />
          {dot && <span className="k-import-dot" data-tone={dot} aria-hidden="true" />}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="k-positioner" side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="k-popup k-import-pop" aria-label="导入">
            <div className="k-import-sources" role="group" aria-label="导入来源">
              <button type="button" className="k-item" disabled={flow.busy} onClick={via(flow.files)}><span className="k-item-ind" aria-hidden="true"><FileImage size={14} /></span><span className="k-item-label">图片</span><kbd className="k-kbd">Ctrl O</kbd></button>
              <button type="button" className="k-item" disabled={flow.busy} onClick={via(() => flow.folder())}><span className="k-item-ind" aria-hidden="true"><FolderOpen size={14} /></span><span className="k-item-label">文件夹</span></button>
              <button type="button" className="k-item" disabled={flow.busy || flow.lookingForEagle} onClick={via(flow.findEagle)}><span className="k-item-ind" aria-hidden="true"><EagleMark /></span><span className="k-item-label">{flow.lookingForEagle ? "正在查找 Eagle 图库…" : "从 Eagle 导入"}</span></button>
            </div>
            {(list.tasks.length > 0 || list.pending || recovery || list.problem || (!notices.toast && flow.error)) && <>
              <div className="k-import-sep" />
              <div className="k-import-tasks" aria-label="导入任务">
                {list.problem && <p className="k-import-problem" role="alert">{list.problem}</p>}
                {!notices.toast && flow.error && <p className="k-import-problem" role="alert">{flow.error}</p>}
                {list.pending && <RunningRow task={null} place={null} />}
                {runningTasks.map((task) => <RunningRow key={task.taskId} task={task} place={task.place} onCancel={() => cancel(task)} />)}
                {doneTasks.map((task) => <ReceiptRow key={task.taskId} task={task} expanded={expanded === task.taskId}
                  onToggle={() => expand(expanded === task.taskId ? null : task.taskId)} onDismiss={() => list.dismiss(task)} onReveal={reveal}
                  onRetry={(paths) => { setOpen(false); void flow.retry(task, paths, false); }}
                  onReimportDeleted={(paths) => { setOpen(false); void flow.retry(task, paths, true); }}
                  onOpenTrash={onOpenTrash && (() => { setOpen(false); onOpenTrash(task.destination?.libraryId ?? destinationLibrary); })}
                  onShowSealed={() => { setOpen(false); setPreview({ libraryId: task.destination?.libraryId ?? destinationLibrary, taskId: task.taskId }); }} />)}
                {recovery && <RecoveryRow recovery={recovery} expanded={expanded === "recovery"} onToggle={() => expand(expanded === "recovery" ? null : "recovery")}
                  onReimport={() => { setShowRecovery(false); setOpen(false); void flow.begin(recovery.interrupted); }} onDismiss={() => setShowRecovery(false)} onReveal={reveal} />}
              </div>
            </>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>

    <ImportPlanDialog plan={flow.plan} setPlan={flow.setPlan} preparing={flow.preparing} busy={active} startPlan={flow.startPlan}
      destinationReady={context.ready && destinationAvailable(context.destination, context.providers)}
      picker={<SaveDestinationPicker value={context.destination} onChange={context.setDestination} labelPrefix="放到" />} />
    <EagleLibrariesDialog eagleLibraries={flow.eagleLibraries} setEagleLibraries={flow.setEagleLibraries} busy={flow.busy}
      begin={(paths, fromEagle) => flow.begin(paths, fromEagle)} pickFolder={() => flow.folder(true)} />
    <RelocationDialog relocation={question?.relocation ?? null} busy={answering || flow.busy}
      onPostpone={() => question && flow.postponeRelocation(question.relocation)}
      onAnswer={(choice) => {
        if (!question) return;
        setAnswering(true);
        void flow.confirmRelocation(question.task, question.relocation, choice === "moved" ? { kind: "moved", sourceId: question.relocation.sourceId } : { kind: "separate" })
          .finally(() => setAnswering(false));
      }} />
    <TagStepDialog libraryId={tagStep} onClose={() => setTagStep(null)} />
    {preview && enabled && <SealedImportPreview key={preview.taskId} libraryId={preview.libraryId} taskId={preview.taskId} onClose={() => setPreview(null)} />}
    {flow.hovering && <div className="drop-hint k-drop-hint" aria-live="polite">
      {context.destination === null ? "松开即可导入，再选放在哪里" : `松开即可导入到 ${context.providers.find((p) => p.registration.library.id === destinationLibrary)?.registration.library.name ?? "尚未选择的图库"}`}
    </div>}
  </div>;
}
