import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, ChevronLeft, CircleAlert, CircleCheck, CircleSlash, Copy, Download, FileImage, FileText, FolderOpen, History, RotateCcw, TriangleAlert, X } from "lucide-react";
import type { RecoveryReport } from "../../bindings/RecoveryReport";
import { baseName, folderOf, importCounts, reason, summary, type ImportTask } from "./report";

/** 28 px 凹槽里的状态图标，与轻提示同一种。 */
const Well = ({ children, tone }: { children: ReactNode; tone?: "danger" | "warn" | "accent" }) =>
  <span className="k-import-well" data-tone={tone} aria-hidden="true">{children}</span>;

const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|psd)$/i.test(path);

/** 进行中的任务：去向、进度条与取消。收尾存标签定义时进度条不定。 */
export function RunningRow({ task, place, onCancel }: { task: ImportTask | null; place: string | null; onCancel?: () => void }) {
  // 报告到了才算内容已导入；之前后端的 finishing 只表示快结束了（#98）。
  const finishing = !!task?.finishing && task.report !== null;
  const { done = 0, total = 0 } = task?.progress ?? {};
  return <div className="k-import-task" role="group" aria-label="导入进度">
    <div className="k-import-head">
      <Well tone="accent"><Download size={16} /></Well>
      <div className="k-import-text">
        <div className="k-import-line"><b className="k-ell">{finishing ? "正在存标签定义" : "正在导入"}</b><span className="k-import-count">{done} / {total}</span></div>
        {place && <span className="k-import-sub k-ell">{place}</span>}
        {finishing ? <span className="k-import-bar is-indeterminate" role="progressbar" aria-label="导入进度" />
          : <progress className="k-import-bar" max={Math.max(total, 1)} value={done} aria-label="导入进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} />}
      </div>
      {onCancel && !finishing && <button type="button" className="k-import-ibtn is-filled" aria-label="取消导入" title="取消导入" onClick={onCancel}><X size={14} aria-hidden="true" /></button>}
    </div>
  </div>;
}

function statusIcon(task: ImportTask): { icon: ReactNode; tone?: "danger" | "warn" } {
  const report = task.report!;
  if (importCounts(report).rejected.length > 0) return { icon: <CircleAlert size={16} />, tone: "danger" };
  if (task.warnings.length > 0) return { icon: <TriangleAlert size={16} />, tone: "warn" };
  if (report.cancelled) return { icon: <CircleSlash size={16} /> };
  return { icon: <CircleCheck size={16} /> };
}

/** 一个文件：文件名与原因，第二行是所在文件夹；整行点开在资源管理器中显示。 */
function FileRow({ path, note, onReveal }: { path: string; note?: string | null; onReveal: (path: string) => void }) {
  return <button type="button" className="k-import-file" title={`在资源管理器中显示：${path}`} onClick={() => onReveal(path)}>
    <span className="k-item-ind" aria-hidden="true">{isImage(path) ? <FileImage size={14} /> : <FileText size={14} />}</span>
    <span className="k-import-text">
      <span className="k-import-line"><span className="k-ell">{baseName(path)}</span>{note && <span className="k-import-sub">{note}</span>}</span>
      <span className="k-import-sub k-ell">{folderOf(path)}</span>
    </span>
    <span className="k-import-reveal" aria-hidden="true"><FolderOpen size={14} /></span>
  </button>;
}

/** 需要处理的一类，带清单的从弹层左侧弹出子菜单（#388 定稿）。 */
function ActRow({ label, count, danger, children, onClick }: { label: string; count?: number; danger?: boolean; children?: ReactNode; onClick?: () => void }) {
  const row = <>
    <span className={danger ? "is-danger" : undefined}>{label}</span>
    {count !== undefined && <span className={`k-import-count${danger ? " is-danger" : ""}`}>{count}</span>}
    {children && <ChevronLeft className="k-import-sub-ind" size={14} aria-hidden="true" />}
  </>;
  if (!children) return <button type="button" className="k-import-act" onClick={onClick}>{row}</button>;
  return <Popover.Root>
    <Popover.Trigger className="k-import-act" openOnHover delay={150} aria-haspopup="menu">{row}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner className="k-positioner" side="left" align="start" sideOffset={6} alignOffset={-6}>
        <Popover.Popup className="k-popup k-import-subpop" aria-label={label}>{children}</Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

const copyPaths = (paths: string[]) => void navigator.clipboard?.writeText(paths.join("\n"));

/** 已结束任务：收起时一行去向与摘要，展开是回执。 */
export function ReceiptRow({ task, expanded, onToggle, onDismiss, onReveal, onRetry, onReimportDeleted, onOpenTrash, onShowSealed }: {
  task: ImportTask; expanded: boolean; onToggle: () => void; onDismiss: () => void; onReveal: (path: string) => void;
  onRetry: (paths: string[]) => void; onReimportDeleted: (paths: string[]) => void; onOpenTrash?: () => void; onShowSealed: () => void;
}) {
  const report = task.report!;
  const counts = importCounts(report);
  const status = statusIcon(task);
  const place = task.place ?? "导入";
  const stats = summary(report);
  const collapsedSummary = <span className="k-import-summary-nums">
    {report.cancelled && <span>已取消</span>}
    {/* 画板：收起行最多两项，有未导入时让给它，免得把去向挤没。 */}
    {stats.slice(0, report.cancelled || counts.rejected.length > 0 ? 1 : 2).map(([label, n]) => <span key={label}>{label} <b>{n}</b></span>)}
    {counts.rejected.length > 0 && <span className="is-danger">未导入 <b>{counts.rejected.length}</b></span>}
  </span>;
  const columns: [string, number][] = report.privateSummary ? [] : [["新增", counts.imported], ["已存在", counts.merged], ["更新", counts.refreshed], ["新版本", counts.newVersions],
    ...(report.eagleMissing > 0 ? [["Eagle 已删", report.eagleMissing] as [string, number]] : [])];
  const warnings = task.warnings.map((warning, index) => <p key={index} className="k-import-warn" role="note">{warning}</p>);
  return <section className="k-import-task" data-expanded={expanded || undefined} aria-label={expanded ? `导入回执：${place}` : undefined}>
    <div className="k-import-head">
      <button type="button" className="k-import-toggle" aria-expanded={expanded} aria-label={`${place}，${report.cancelled ? "导入已取消" : "导入完成"}`} onClick={onToggle}>
        <Well tone={status.tone}>{status.icon}</Well>
        <span className={`k-ell k-import-place${expanded ? " is-strong" : ""}`}>{place}</span>
        {!expanded && collapsedSummary}
      </button>
      <button type="button" className="k-import-ibtn k-import-remove" aria-label="移除记录" title="移除记录" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
      <button type="button" className="k-import-ibtn" tabIndex={-1} aria-hidden="true" onClick={onToggle}><ChevronDown size={14} className="k-import-chev" /></button>
    </div>
    {/* 警告收起时也露出来（画板“存标签、警告、上次中断”），免得要点开才知道。 */}
    {!expanded && task.warnings.length > 0 && <div className="k-import-body">{warnings}</div>}
    {expanded && <div className="k-import-body">
      {report.privateSummary ? <p className="k-import-sub">内容处理结果已保留</p>
        : <div className="k-import-nums">{columns.map(([label, n]) => <div key={label}><span className="k-import-num">{n}</span><span className="k-import-sub">{label}</span></div>)}</div>}
      {warnings}
      {(counts.rejected.length > 0 || counts.skippedDeleted.length > 0 || counts.trashDuplicate || report.sealedDuplicates) && <div className="k-import-acts" aria-label="需要处理的">
        {counts.rejected.length > 0 && <ActRow label="未导入" count={counts.rejected.length} danger>
          <div className="k-import-files">{counts.rejected.map((item) => <FileRow key={item.path} path={item.path} note={reason(item.outcome)} onReveal={onReveal} />)}</div>
          <div className="k-import-sep" />
          {counts.failed.length > 0 && <button type="button" className="k-item" aria-label={`重试读取失败的 ${counts.failed.length} 项`} onClick={() => onRetry(counts.failed)}>
            <span className="k-item-ind" aria-hidden="true"><RotateCcw size={14} /></span><span className="k-item-label">重试读取失败的</span><span className="k-kbd">{counts.failed.length}</span></button>}
          <button type="button" className="k-item" onClick={() => copyPaths(counts.rejected.map((item) => item.path))}>
            <span className="k-item-ind" aria-hidden="true"><Copy size={14} /></span><span className="k-item-label">复制全部路径</span></button>
        </ActRow>}
        {counts.skippedDeleted.length > 0 && <ActRow label="删过的图已跳过" count={counts.skippedDeleted.length}>
          <div className="k-import-files">{counts.skippedDeleted.map((path) => <FileRow key={path} path={path} onReveal={onReveal} />)}</div>
          <div className="k-import-sep" />
          <button type="button" className="k-item" onClick={() => onReimportDeleted(counts.skippedDeleted)}>
            <span className="k-item-ind" aria-hidden="true"><Download size={14} /></span><span className="k-item-label">这次也导入…</span></button>
        </ActRow>}
        {/* #78：回收站里的重复只给布尔提示，不列名字与数量。 */}
        {counts.trashDuplicate && onOpenTrash && <ActRow label="回收站里有重复，去回收站" onClick={onOpenTrash} />}
        {/* #78 规定的原文：不点名内容类别，不给数量；不做悬停子菜单，免得把图露在屏幕上。 */}
        {report.sealedDuplicates && <ActRow label="有封印项重复，是否展开看看" onClick={onShowSealed} />}
      </div>}
    </div>}
  </section>;
}

/** 上次导入中断：撤回的文件可以重新导入；原文件夹里不认识的文件只报告。 */
export function RecoveryRow({ recovery, expanded, onToggle, onReimport, onDismiss, onReveal }: {
  recovery: RecoveryReport; expanded: boolean; onToggle: () => void; onReimport: () => void; onDismiss: () => void; onReveal: (path: string) => void;
}) {
  const { interrupted, orphans } = recovery;
  const [listing, setListing] = useState(false);
  return <section className="k-import-task" data-expanded={expanded || undefined} aria-label={interrupted.length > 0 ? "上次导入中断" : "有不认识的文件"}>
    <div className="k-import-head">
      <button type="button" className="k-import-toggle is-tall" aria-expanded={expanded} onClick={onToggle}>
        <Well><History size={16} /></Well>
        <span className="k-import-text">
          <b className="k-ell">{interrupted.length > 0 ? "上次导入中断" : "有不认识的文件"}</b>
          <span className="k-import-sub">{[interrupted.length > 0 && `${interrupted.length} 个文件已撤回，没有留下半张图`,
            orphans.length > 0 && `原文件夹里有 ${orphans.length} 个不认识的文件，已保留`].filter(Boolean).join("；")}</span>
        </span>
      </button>
      <button type="button" className="k-import-ibtn k-import-remove is-shown" aria-label="移除记录" title="移除记录" onClick={onDismiss}><X size={14} aria-hidden="true" /></button>
    </div>
    {interrupted.length > 0 && <div className="k-import-body is-row">
      <button type="button" className="k-btn is-sm" onClick={onReimport}><span className="k-label">重新导入</span></button>
      <button type="button" className="k-import-link" aria-expanded={listing} onClick={() => setListing((on) => !on)}>{listing ? "收起文件" : "查看文件"}</button>
    </div>}
    {listing && <div className="k-import-files is-inline">{interrupted.map((path) => <FileRow key={path} path={path} onReveal={onReveal} />)}</div>}
  </section>;
}
