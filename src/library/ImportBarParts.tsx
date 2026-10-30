import type { SaveDestination } from "../bindings/SaveDestination";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleCheck, CircleSlash, FolderOpen, Images, Library, X } from "lucide-react";
import type { ImportOptions } from "../bindings/ImportOptions";
import type { ImportOutcome } from "../bindings/ImportOutcome";
import type { ImportReport } from "../bindings/ImportReport";
import type { EagleLibraryCandidate } from "../bindings/EagleLibraryCandidate";
import { describeCommandError } from "../ipc/commandError";
import type { FinishedImport, RunningImport } from "./ImportBar";

export type ImportPlan = { paths: string[]; options: ImportOptions; eagle:boolean };
type Begin = (paths: string[], fromEagle?: boolean, options?: ImportOptions, fixed?:SaveDestination) => Promise<void>;

function reason(outcome: ImportOutcome): string | null {
  switch (outcome.kind) {
    case "unsupported":
      return "不支持的格式";
    case "readFailed":
      return `读取失败：${describeCommandError(outcome.reason)}`;
    default:
      return null;
  }
}

/** 导入结果卡片：新增、已存在与没导入的文件，可只重试读取失败的项。 */
export function ImportResultCard({ report, finished, owner, taskSwitcher, cardNotes, busy, begin, optionsByTask, libraryId, onOpenTrash, onDismissReport }: {
  report: ImportReport; finished: FinishedImport | null; owner: string | null; taskSwitcher?: ReactNode; cardNotes?: ReactNode;
  busy: boolean; begin: Begin; optionsByTask: { current: Map<string, ImportOptions> }; libraryId: string;
  onOpenTrash?: (libraryId?:string) => void; onDismissReport: () => void;
}) {
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
  return (
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
        onClick={() => void begin(counts.failed, false, finished ? optionsByTask.current.get(finished.taskId) : undefined, finished?.destination)}><span className="k-label">重试失败</span></button>
    </div>}
  </section>
  );
}

/** 导入前的确认对话框：来源、保存位置，Eagle 另问删过的图。 */
export function ImportPlanDialog({ plan, setPlan, preparing, running, destinationReady, startPlan, picker }: {
  plan: ImportPlan | null; setPlan: Dispatch<SetStateAction<ImportPlan | null>>; preparing: boolean; running: RunningImport | null;
  destinationReady: boolean; startPlan: () => Promise<void>; picker?: ReactNode;
}) {
  return (
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
            <button type="button" className="k-btn" disabled={preparing} onClick={() => setPlan(null)}><span className="k-label">取消</span></button>
            <button type="button" className="k-btn is-primary" disabled={preparing || !!running || !destinationReady} onClick={() => void startPlan()}><span className="k-label">开始导入</span></button>
          </div>
        </>}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 找到的 Eagle 库，或手动选择。 */
export function EagleLibrariesDialog({ eagleLibraries, setEagleLibraries, busy, begin, importFolder }: {
  eagleLibraries: EagleLibraryCandidate[] | null; setEagleLibraries: Dispatch<SetStateAction<EagleLibraryCandidate[] | null>>;
  busy: boolean; begin: Begin; importFolder: (fromEagle?: boolean) => Promise<void>;
}) {
  return (
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
                <p className="k-list-desc k-parts" title={candidate.path}><span>{candidate.items} 张</span>{candidate.version && <span>Eagle {candidate.version}</span>}<span>{candidate.path}</span></p>
              </div>
              <div className="k-list-end"><button type="button" className="k-btn is-sm" aria-label={`导入 ${candidate.name}`} disabled={busy} onClick={() => { setEagleLibraries(null); void begin([candidate.path], true); }}><span className="k-label">导入</span></button></div>
            </li>)}
          </ul> : <p className="k-set-note" role="status">没有自动找到 Eagle 库，可以手动选择。</p>}
          <p className="k-set-note">回收站里的图会进入可恢复的删除；区域评论会保留，暂不显示。</p>
          <div className="k-dialog-foot">
            <button type="button" className="k-btn" disabled={busy} onClick={() => { setEagleLibraries(null); void importFolder(true); }}><FolderOpen size={14} aria-hidden="true" /><span className="k-label">手动选择…</span></button>
            <span className="k-grow" />
            <button type="button" className="k-btn" onClick={() => setEagleLibraries(null)}><span className="k-label">取消</span></button>
          </div>
        </>}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
