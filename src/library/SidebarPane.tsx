import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { NameInput } from "../ui/NameInput";
import { Name } from "../ui/Name";
import { useTranslation } from "react-i18next";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { FolderNode } from "../bindings/FolderNode";
import type { Sidebar } from "../bindings/Sidebar";
import { createFolder, deleteFolder, editImages, moveFolder, renameFolder, restoreFolder } from "../ipc";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES } from "../wall/Wall";
import { Folder, FolderPlus, FolderUp, FolderX, Inbox, Pencil } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { FluidList, FluidRow } from "../ui/FluidList";
import { MenuItem, MenuPopup, MenuSeparator } from "../ui/Menu";
import { isMenuKey, openMenuAt } from "../ui/menuKey";
import { useToast } from "../ui/Toast";
import { FoldIcon } from "./FoldIcon";
import { useFolded } from "./useFolded";
import { Tip } from "../ui/Tip";
import { armFolderDrag, type FolderDragHost } from "./folderDrag";
import { moveAndSettle, placesNow } from "./folderDragMotion";
import { keyMove, LAST, locate, placeAfter, type FolderMove } from "./folderMove";

export { LAST };

type Props = {
  directory: Sidebar;
  unassigned?: number;
  descendantCounts?: { [id: string]: number | undefined };
  includeDescendants?: boolean;
  /** 目录导航的无障碍名称里用的图库名。 */
  libraryName: string;
  libraryId: string;
  /** 这个图库里正在看的范围；scopeSelected 为假时（看的是别处）不标当前行。 */
  scope: BrowseScope;
  scopeSelected: boolean;
  onScope: (scope: BrowseScope) => void;
  onError: (error: unknown) => void;
  /** 正在新建文件夹（由图库标题的 ⋯ 菜单发起）：新文件夹放在 parentForNew 下，null 为顶层。 */
  creating: boolean;
  parentForNew: string | null;
  onCreatingDone: () => void;
};

const same = (a: BrowseScope, b: BrowseScope) =>
  (a.kind === b.kind || [a.kind, b.kind].every((kind) => kind === "folder" || kind === "folderTree")) &&
  ((a.kind !== "folder" && a.kind !== "folderTree") ||
    ((b.kind === "folder" || b.kind === "folderTree") && a.id === b.id));

/** 文件夹及其全部子文件夹的 id。 */
function subtree(node: FolderNode): string[] {
  return [node.id, ...node.children.flatMap(subtree)];
}

/** 放进某个图库文件夹的图：图片墙按图库给出每张图的来源，只取它在这个库里的来源（#112）。 */
export function droppedImages(e: DragEvent, libraryId: string): string[] {
  const sources = e.dataTransfer.getData(DRAG_IMAGE_SOURCES);
  return sources
    ? ((JSON.parse(sources) as Record<string, string[] | undefined>)[libraryId] ?? [])
    : (JSON.parse(e.dataTransfer.getData(DRAG_IMAGES) || "[]") as string[]);
}

const inTree = (nodes: FolderNode[], id: string): boolean =>
  nodes.some((node) => node.id === id || inTree(node.children, id));

/** 图片墙上的图拖过来（文件夹自己的拖动用指针事件，见 folderDrag.ts）。 */
export const acceptsDrag = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_IMAGES);

/**
 * 一个图库在侧栏里展开后的内容（方案 D）：未归类与文件夹树，计数只算可见的图。
 * 双击或 F2 改名；拖动文件夹排顺序或放进另一个文件夹（#636，folderDrag.ts），Alt + 方向键同样能挪；把图片墙上选中的图拖到文件夹上放进去。
 * 文件夹的右键菜单（#102 表“侧栏 · 文件夹”，#114）：新建子文件夹 · 重命名 · ─ · 移到顶层 · ─ · 删除文件夹。
 */
export function SidebarPane({
  libraryId,
  libraryName,
  scope,
  scopeSelected,
  onScope,
  onError,
  directory,
  unassigned,
  descendantCounts,
  includeDescendants = false,
  creating,
  parentForNew,
  onCreatingDone,
}: Props) {
  const { t } = useTranslation("library");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** 右键“新建子文件夹”所在的文件夹。 */
  const [creatingUnder, setCreatingUnder] = useState<string | null>(null);
  const toast = useToast();
  const [folded, toggleFold, closing] = useFolded(libraryId);

  const run = (p: Promise<unknown>) => p.catch((e) => onError(e));

  /** 新文件夹放在哪里：右键的那个文件夹，或图库标题菜单给出的位置；undefined 为没有在新建。 */
  const newParent = creatingUnder ?? (creating ? parentForNew : undefined);
  const created = (name: string | null) => {
    const parent = newParent ?? null;
    setCreatingUnder(null);
    onCreatingDone();
    if (name) void run(createFolder(libraryId, name, parent));
  };
  const newInput = <NameInput label={t("folders.newName")} initial="" onDone={created} />;

  /** 删除文件夹能撤销，所以不先确认：直接删，再给一个带“撤销”的轻提示；撤销用的是删除时返回的内容。 */
  const removeFolder = (node: FolderNode) => {
    const removed = subtree(node);
    deleteFolder(libraryId, node.id).then(
      (deleted) => {
        // 正在看的文件夹（或它的子文件夹）没了：回到这个图库的全部。
        if (scopeSelected && (scope.kind === "folder" || scope.kind === "folderTree") && removed.includes(scope.id))
          onScope({ kind: "all" });
        toast.show({
          title: t("deleteFolder.done"),
          description: node.name,
          tone: "success",
          action: {
            label: t("deleteFolder.undo"),
            onClick: () => {
              restoreFolder(libraryId, deleted).catch((e) => onError(e));
            },
          },
        });
      },
      (e) => onError(e),
    );
  };

  /** 挪完读给读屏用户听的一句。 */
  const [moved, setMoved] = useState("");
  /** 挪文件夹（拖动或 Alt + 方向键）：放进折起的文件夹时先展开它，挪过去的那一行才看得见。 */
  const moveTo = (folderId: string, to: FolderMove) => {
    const node = locate(directory.folders, folderId)?.siblings.find((n) => n.id === folderId);
    const inside =
      to.parent === null ? null : locate(directory.folders, to.parent)?.siblings.find((n) => n.id === to.parent);
    const place = placeAfter(directory.folders, folderId, to);
    return moveFolder(libraryId, folderId, to.parent, to.position).then(
      () => {
        if (inside && folded.has(inside.id)) toggleFold(inside.id);
        if (node)
          setMoved(
            inside
              ? t("folders.movedInto", { name: node.name, parent: inside.name, place })
              : t("folders.movedTop", { name: node.name, place }),
          );
      },
      (e: unknown) => {
        onError(e);
        throw e;
      },
    );
  };
  // 拖动跨好几帧，期间目录可能重画：拖动拿到的是这个转接，调用时总用最新的 moveTo。
  const latest = useRef(moveTo);
  latest.current = moveTo;
  const host = useRef<FolderDragHost>({ move: (id, to) => latest.current(id, to) }).current;
  const disarm = useRef<() => void>(() => {});
  useEffect(() => () => disarm.current(), []);

  const over = (target: string) => (e: DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    setDropTarget(target);
  };

  const drop = (folderId: string) => (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    try {
      const images = droppedImages(e, libraryId);
      if (images.length) void run(editImages(libraryId, images, [{ kind: "addToFolder", folderId }]));
    } catch (error) {
      onError(error);
    }
  };

  const count = (node: FolderNode) => (includeDescendants ? (descendantCounts?.[node.id] ?? node.count) : node.count);
  const current = (target: BrowseScope) => (scopeSelected && same(scope, target) ? ("page" as const) : undefined);
  /** 选中的文件夹在这一支里（不含它自己）：沿路的文件夹图标带一点强调色，折起时也一样。 */
  const holdsCurrent = (node: FolderNode): boolean =>
    node.children.some((child) => current({ kind: "folder", id: child.id }) !== undefined || holdsCurrent(child));

  // Rows join one fluid-hover list in visible (pre-order) order.
  let row = 0;
  const tree = (nodes: FolderNode[], depth = 0, folding = false, parentId: string | null = null) => (
    <ul
      role="group"
      className="sidebar-tree"
      style={{ "--depth": depth } as CSSProperties}
      data-closing={folding || undefined}
      inert={folding}
    >
      {nodes.map((node, i) => {
        const parent = node.children.length > 0;
        // 要在这一支里新建文件夹时，沿路折起的先展开，名字输入框才看得见。
        const fold = parent && folded.has(node.id) && !(newParent && inTree([node], newParent));
        return (
          <li
            key={node.id}
            role="treeitem"
            aria-label={node.name}
            style={{ "--i": Math.min(i, 14) } as CSSProperties}
            aria-expanded={parent ? !fold : undefined}
            data-parent={parent || undefined}
            data-folded={fold || undefined}
            data-branch={holdsCurrent(node) || undefined}
          >
            {renaming === node.id ? (
              <NameInput
                label={t("folders.name")}
                initial={node.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== node.name) void run(renameFolder(libraryId, node.id, name));
                }}
              />
            ) : (
              <FluidRow index={row++}>
                <ContextMenu.Root>
                  <ContextMenu.Trigger
                    render={
                      <button
                        type="button"
                        data-folder-id={node.id}
                        className="sidebar-item k-row"
                        data-depth={depth}
                        data-parent-folder={parentId ?? undefined}
                        data-drop={dropTarget === node.id || undefined}
                        aria-current={current({ kind: "folder", id: node.id })}
                        aria-label={t("folders.folderCount", { name: node.name, count: count(node) })}
                        onClick={() => onScope({ kind: "folder", id: node.id })}
                        onDoubleClick={() => setRenaming(node.id)}
                        onPointerDown={(e) => {
                          disarm.current();
                          disarm.current = armFolderDrag(e.currentTarget, e.nativeEvent, host);
                        }}
                        onDragOver={over(node.id)}
                        onDragLeave={() => setDropTarget(null)}
                        onDrop={drop(node.id)}
                        onKeyDown={(e) => {
                          const step =
                            e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey
                              ? keyMove(directory.folders, node.id, e.key)
                              : null;
                          if (e.altKey && e.key.startsWith("Arrow")) {
                            // Alt + 方向键挪文件夹；挪不动时也不让按键做别的事。
                            e.preventDefault();
                            const nav = e.currentTarget.closest("nav.sidebar");
                            if (step && nav) {
                              const from = placesNow(nav);
                              void moveAndSettle(nav, node.id, () => moveTo(node.id, step), from);
                            }
                          } else if (parent && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                            // ← 折起、→ 展开；已经是那个样子时不吃掉按键。
                            if ((e.key === "ArrowLeft") !== fold) {
                              e.preventDefault();
                              toggleFold(node.id);
                            }
                          } else if (e.key === "F2") {
                            e.preventDefault();
                            setRenaming(node.id);
                          } else if (isMenuKey(e)) {
                            e.preventDefault();
                            openMenuAt(e.currentTarget);
                          }
                        }}
                      />
                    }
                  >
                    {parent ? (
                      // 点图标折起或展开，不选中这一行；连点两下也不进入改名。悬停写明点它做什么。
                      <Tip label={fold ? t("folders.unfold") : t("folders.fold")} side="right" focus={false}>
                        <span
                          className="k-row-icon k-fold"
                          aria-hidden="true"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            toggleFold(node.id);
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                          }}
                        >
                          <FoldIcon />
                        </span>
                      </Tip>
                    ) : (
                      <span className="k-row-icon" aria-hidden="true">
                        <Folder size={15} />
                      </span>
                    )}
                    <Name className="sidebar-label k-label">{node.name}</Name>
                    <span className="sidebar-count k-label">{count(node)}</span>
                  </ContextMenu.Trigger>
                  <MenuPopup label={t("folders.actions", { name: node.name })} width={200}>
                    <MenuItem
                      icon={<FolderPlus size={14} />}
                      onClick={() => {
                        onCreatingDone();
                        setCreatingUnder(node.id);
                      }}
                    >
                      {t("folders.newSubfolder")}
                    </MenuItem>
                    <MenuItem icon={<Pencil size={14} />} kbd="F2" onClick={() => setRenaming(node.id)}>
                      {t("folders.rename")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<FolderUp size={14} />}
                      disabled={depth === 0}
                      onClick={() => void run(moveFolder(libraryId, node.id, null, LAST))}
                    >
                      {t("folders.moveToTop")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<FolderX size={14} />} danger onClick={() => removeFolder(node)}>
                      {t("folders.delete")}
                    </MenuItem>
                  </MenuPopup>
                </ContextMenu.Root>
              </FluidRow>
            )}
            {(parent || newParent === node.id) && (
              <>
                {parent && (!fold || closing.has(node.id)) && tree(node.children, depth + 1, fold, node.id)}
                {newParent === node.id && newInput}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav className="sidebar" aria-label={t("folders.treeOf", { name: libraryName })}>
      <FluidList indented>
        {unassigned !== undefined && (
          <FluidRow index={row++}>
            <button
              type="button"
              className="sidebar-item k-row"
              aria-current={current({ kind: "unassigned" })}
              aria-label={t("folders.unassignedCount", { count: unassigned })}
              onClick={() => onScope({ kind: "unassigned" })}
            >
              <span className="k-row-icon" aria-hidden="true">
                <Inbox size={15} />
              </span>
              <span className="sidebar-label k-label">{t("folders.unassigned")}</span>
              <span className="sidebar-count k-label">{unassigned}</span>
            </button>
          </FluidRow>
        )}
        <div role="tree" aria-label={t("folders.tree")} className="sidebar-folders">
          {tree(directory.folders)}
          {/* 放在顶层，或要放进的文件夹已不在树里时放在最后。 */}
          {newParent !== undefined && (newParent === null || !inTree(directory.folders, newParent)) && newInput}
        </div>
      </FluidList>
      <div className="sr-only" role="status">
        {moved}
      </div>
    </nav>
  );
}
