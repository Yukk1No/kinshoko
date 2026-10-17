import { Download, FileImage, FolderOpen, Lightbulb, ListChecks } from "lucide-react";
import { MenuItem, MenuSeparator, MenuTip } from "./Menu";
import { SplitButton } from "./SplitButton";

/** Eagle has no lucide icon; a small line mark in the same weight. */
const EagleMark = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14c4-1 6-4 9-9 1 4 3 6 9 7-4 1-7 3-9 8-1-3-4-5-9-6Z" /></svg>;

/**
 * 导入 (design/ui-system/README.md, 按钮): icon and chevron only, no fill (#102 故事14), so the top bar's
 * weight stays on the search. The icon imports image files, the chevron offers
 * 图片文件 / 整个文件夹 / 从 Eagle 导入 and the drag-in tip. While an import runs nothing new can start,
 * but the running and finished tasks stay reachable.
 */
export function ImportSplit({ onFiles, onFolder, onEagle, onShowTasks, busy = false, eagleBusy = false }: {
  onFiles: () => void; onFolder: () => void; onEagle: () => void; onShowTasks?: () => void; busy?: boolean; eagleBusy?: boolean;
}) {
  return <SplitButton className="k-import" icon={<Download size={18} strokeWidth={1.75} aria-hidden="true" />}
    mainLabel="导入图片文件" onMain={onFiles} mainDisabled={busy} busy={busy} menuLabel="更多导入方式" menuDisabled={busy && !onShowTasks}>
    <MenuItem icon={<FileImage size={14} />} disabled={busy} onClick={onFiles}>图片文件…</MenuItem>
    <MenuItem icon={<FolderOpen size={14} />} disabled={busy} onClick={onFolder}>整个文件夹…</MenuItem>
    <MenuItem icon={<EagleMark />} disabled={busy || eagleBusy} onClick={onEagle}>{eagleBusy ? "正在查找 Eagle 图库…" : "从 Eagle 导入…"}</MenuItem>
    {onShowTasks && <MenuItem icon={<ListChecks size={14} />} onClick={onShowTasks}>查看导入任务</MenuItem>}
    <MenuSeparator />
    <MenuTip icon={<Lightbulb size={14} />}>也可以直接拖进窗口</MenuTip>
  </SplitButton>;
}
