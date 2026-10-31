import type { ReactNode } from "react";
import { FolderOpen, FolderPlus, ListX, RefreshCw, Trash2 } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { useTranslation } from "react-i18next";
import { FluidList, FluidRow } from "../ui/FluidList";
import { MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { FolderNode } from "../bindings/FolderNode";

export function folderPath(nodes: FolderNode[], id: string, parent: string[] = []): string[] | null {
  for (const node of nodes) {
    const path = [...parent, node.name];
    if (node.id === id) return path;
    const found = folderPath(node.children, id, path);
    if (found) return found;
  }
  return null;
}

/**
 * 图库标题的操作（#102 表“侧栏 · 图库标题”，#114）：`⋯` 与右键菜单是同一组菜单项。
 * 新建文件夹 · 在资源管理器中打开 · 重新连接（未连接时） · ─ · 从列表移除。
 */
export function LibraryMenuItems({ provider, onNewFolder, onReveal, onRecheck, onRemove }: {
  provider: WorkspaceDirectory; onNewFolder: () => void; onReveal: () => void; onRecheck?: () => void; onRemove: () => void;
}) {
  const { t } = useTranslation("library", { keyPrefix: "libraryMenu" });
  return <>
    <MenuItem icon={<FolderPlus size={14} />} disabled={!provider.sidebar || Boolean(provider.registration.unavailable)} onClick={onNewFolder}>{t("newFolder")}</MenuItem>
    <MenuItem icon={<FolderOpen size={14} />} onClick={onReveal}>{t("reveal")}</MenuItem>
    {provider.registration.unavailable && onRecheck && <MenuItem icon={<RefreshCw size={14} />} onClick={onRecheck}>{t("reconnect")}</MenuItem>}
    <MenuSeparator />
    <MenuItem icon={<ListX size={14} />} onClick={onRemove}>{t("remove")}</MenuItem>
  </>;
}

/**
 * 回收站行：选中某库时是该库的回收站，选“全部图片”时是各库合计（ADR-0008）。
 * 右键菜单（#102 表“侧栏 · 回收站”，#114）：清空回收站，危险项，先确认。
 */
export function TrashRow({ label, count, current, expanded, disabled, onClick, menu }: {
  label: string; count: number | undefined; current?: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void; menu: ReactNode;
}) {
  const { t } = useTranslation("library", { keyPrefix: "trash" });
  return <FluidList><FluidRow index={0}>
    <ContextMenu.Root>
      <ContextMenu.Trigger render={<button type="button" className="sidebar-item k-row" aria-current={current ? "page" : undefined} aria-expanded={expanded}
        disabled={disabled} aria-label={count === undefined ? t("labelLoading", { library: label }) : t("label", { library: label, count })} title={label} onClick={onClick} />}>
        <span className="k-row-icon" aria-hidden="true"><Trash2 size={15} /></span>
        <span className="sidebar-label k-label">{t("title")}</span>
        <span className="sidebar-count k-label">{count ?? ""}</span>
      </ContextMenu.Trigger>
      <MenuPopup label={t("actions")} width={220}>{menu}</MenuPopup>
    </ContextMenu.Root>
  </FluidRow></FluidList>;
}
