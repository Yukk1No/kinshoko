import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FolderOpen, Images, Library, MapPinned } from "lucide-react";
import type { EagleLibraryCandidate } from "../../bindings/EagleLibraryCandidate";
import type { EagleRelocation } from "../../bindings/EagleRelocation";
import { EagleTagStep } from "../EagleTagStep";
import { baseName, type ImportPlan } from "./report";

/** 导入前的确认对话框：来源、保存位置，Eagle 另问删过的图。 */
export function ImportPlanDialog({ plan, setPlan, preparing, busy, destinationReady, startPlan, picker }: {
  plan: ImportPlan | null; setPlan: Dispatch<SetStateAction<ImportPlan | null>>; preparing: boolean; busy: boolean;
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
            <span className="k-import-well" aria-hidden="true">{plan.eagle ? <Library size={16} /> : <Images size={16} />}</span>
            <div className="k-list-text">
              <div className="k-list-title">{plan.paths.length === 1 ? baseName(plan.paths[0]) : `${plan.paths.length} 个文件或文件夹`}</div>
              {plan.paths.length === 1 ? <p className="k-import-sub" title={plan.paths[0]}>{plan.paths[0]}</p>
                : <details className="k-import-more"><summary>来自</summary><ul>{plan.paths.map((path) => <li key={path}>{path}</li>)}</ul></details>}
            </div>
          </div>
          {picker}
          {/* 补充说明放进悬停提示（设计系统 v2：不写解释性提示行）。 */}
          {plan.eagle && <fieldset className="k-fieldset" disabled={preparing || busy} title="新版本照常导入；回收站里的重复项保持删除。">
            <legend className="k-field-label">删过的图</legend>
            <div className="k-radio-cards">
              {([["skipDeleted", "继续跳过", "之前删掉的不再导入"], ["allowThisImport", "这次也导入", "只对这一次有效"]] as const).map(([value, title, desc]) =>
                <label key={value} className={`k-radio-card${plan.options.eagleDeletedContent === value ? " is-on" : ""}`}>
                  <input type="radio" name="eagle-deleted-content" checked={plan.options.eagleDeletedContent === value}
                    onChange={() => setPlan({ ...plan, options: { eagleDeletedContent: value } })} />
                  <span><span className="k-radio-title">{title}</span><span className="k-radio-desc">{desc}</span></span>
                </label>)}
            </div>
          </fieldset>}
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <button type="button" className="k-btn" disabled={preparing} onClick={() => setPlan(null)}><span className="k-label">取消</span></button>
            <button type="button" className="k-btn is-primary" disabled={preparing || busy || !destinationReady} onClick={() => void startPlan()}><span className="k-label">开始导入</span></button>
          </div>
        </>}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 找到的 Eagle 库，或手动选择。 */
export function EagleLibrariesDialog({ eagleLibraries, setEagleLibraries, busy, begin, pickFolder }: {
  eagleLibraries: EagleLibraryCandidate[] | null; setEagleLibraries: Dispatch<SetStateAction<EagleLibraryCandidate[] | null>>;
  busy: boolean; begin: (paths: string[], fromEagle: boolean) => Promise<void>; pickFolder: () => Promise<void>;
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
            <button type="button" className="k-btn" disabled={busy} onClick={() => { setEagleLibraries(null); void pickFolder(); }}><FolderOpen size={14} aria-hidden="true" /><span className="k-label">手动选择…</span></button>
            <span className="k-grow" />
            <button type="button" className="k-btn" onClick={() => setEagleLibraries(null)}><span className="k-label">取消</span></button>
          </div>
        </>}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * 导入前必须回答的问题（#388）：疑似搬了家的 Eagle 库。确认前不导入；Esc 或关掉 = 这次不导入、也不记住选择，
 * 下次导入同一位置时再问。
 */
export function RelocationDialog({ relocation, busy, onAnswer, onPostpone }: {
  relocation: EagleRelocation | null; busy: boolean;
  onAnswer: (choice: "moved" | "separate") => void; onPostpone: () => void;
}) {
  return (
    <Dialog.Root open={relocation !== null} onOpenChange={(open) => { if (!open) onPostpone(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog k-import-dialog">{relocation && <>
          <Dialog.Title className="k-dialog-title">Eagle 库换了位置？</Dialog.Title>
          <Dialog.Description className="k-dialog-desc">这里有 {relocation.overlapPercent}% 的图已经从另一个位置导入过。确认前不会导入任何内容。</Dialog.Description>
          <div className="k-import-summary">
            <span className="k-import-well" aria-hidden="true"><MapPinned size={16} /></span>
            <dl className="k-import-paths">
              <dt>新位置</dt><dd title={relocation.to}>{relocation.to}</dd>
              <dt>原位置</dt><dd title={relocation.from}>{relocation.from}</dd>
            </dl>
          </div>
          <div className="k-dialog-foot">
            <span className="k-grow" />
            <button type="button" className="k-btn" disabled={busy} onClick={() => onAnswer("separate")}><span className="k-label">是另一个库</span></button>
            <button type="button" className="k-btn is-primary" disabled={busy} onClick={() => onAnswer("moved")}><span className="k-label">是同一个库</span></button>
          </div>
        </>}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Eagle 迁入结束后的“标签的外部对应”一步（#77 UI-E）。 */
export function TagStepDialog({ libraryId, onClose }: { libraryId: string | null; onClose: () => void }) {
  return (
    <Dialog.Root open={libraryId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="k-backdrop" />
        <Dialog.Popup className="k-dialog k-import-dialog is-wide" aria-label="补上标签对应">
          {libraryId !== null && <EagleTagStep libraryId={libraryId} onClose={onClose} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
