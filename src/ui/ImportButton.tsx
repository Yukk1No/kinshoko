import { ChevronDown, Download, FileImage, FolderOpen, ListChecks } from "lucide-react";
import { Menu, MenuItem, MenuPopup } from "./Menu";

/** Eagle has no lucide icon; a small line mark in the same weight. */
const EagleMark = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 14c4-1 6-4 9-9 1 4 3 6 9 7-4 1-7 3-9 8-1-3-4-5-9-6Z" /></svg>;

/**
 * 导入（设计系统 ImportButton）：顶栏里一个无底的按钮，点开菜单再选来源：图片（Ctrl O）、文件夹、从 Eagle 导入。
 * 不用分体按钮，用户不必先判断点左半还是右半；最常用的导入图片有快捷键，拖进窗口也能直接导入。
 * 导入进行中不能开始新的导入，但运行中与已结束的任务仍能从菜单打开。
 */
export function ImportButton({ onFiles, onFolder, onEagle, onShowTasks, busy = false, eagleBusy = false }: {
  onFiles: () => void; onFolder: () => void; onEagle: () => void; onShowTasks?: () => void; busy?: boolean; eagleBusy?: boolean;
}) {
  return <Menu.Root modal={false}>
    <Menu.Trigger className="k-import" aria-label={busy ? "正在导入" : "导入"} title="导入" aria-busy={busy || undefined} disabled={busy && !onShowTasks}>
      <Download size={18} strokeWidth={1.75} aria-hidden="true" />
      <ChevronDown className="k-import-chev" size={14} aria-hidden="true" />
    </Menu.Trigger>
    <MenuPopup align="end" sideOffset={8} width={220}>
      <MenuItem icon={<FileImage size={14} />} kbd="Ctrl O" disabled={busy} onClick={onFiles}>图片</MenuItem>
      <MenuItem icon={<FolderOpen size={14} />} disabled={busy} onClick={onFolder}>文件夹</MenuItem>
      <MenuItem icon={<EagleMark />} disabled={busy || eagleBusy} onClick={onEagle}>{eagleBusy ? "正在查找 Eagle 图库…" : "从 Eagle 导入"}</MenuItem>
      {onShowTasks && <MenuItem icon={<ListChecks size={14} />} onClick={onShowTasks}>导入任务</MenuItem>}
    </MenuPopup>
  </Menu.Root>;
}
