import { useState, type DragEvent, type KeyboardEvent } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { FolderNode } from "../bindings/FolderNode";
import type { Sidebar } from "../bindings/Sidebar";
import { createFolder, editImages, moveFolder, renameFolder } from "../ipc";
import { DRAG_IMAGE_SOURCES, DRAG_IMAGES } from "../wall/Wall";
import { Folder, FolderOpen, Inbox } from "lucide-react";
import { FluidList, FluidRow } from "../ui/FluidList";

/** 侧栏里拖动文件夹时放进 dataTransfer 的类型，值为文件夹 id。 */
export const DRAG_FOLDER = "application/x-kinshoko-folder";
/** 与 {@link DRAG_FOLDER} 同时放入：文件夹所属图库的 id。文件夹只能在本库内移动。 */
export const DRAG_FOLDER_LIBRARY = "application/x-kinshoko-folder-library";
/** 移动文件夹时放到新位置的最后。 */
export const LAST = 2 ** 31;

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
  onError: (message: string) => void;
  /** 正在新建文件夹（由图库标题的 ⋯ 菜单发起）：新文件夹放在 parentForNew 下，null 为顶层。 */
  creating: boolean;
  parentForNew: string | null;
  onCreatingDone: () => void;
};

const same = (a: BrowseScope, b: BrowseScope) =>
  (a.kind === b.kind || ([a.kind, b.kind].every((kind) => kind === "folder" || kind === "folderTree"))) &&
  ((a.kind !== "folder" && a.kind !== "folderTree") || ((b.kind === "folder" || b.kind === "folderTree") && a.id === b.id));

/** 只在文本框里按 Enter 提交、Esc 放弃。 */
export function NameInput(props: {
  label: string;
  initial: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(props.initial);
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") props.onDone(value.trim() || null);
    if (e.key === "Escape") props.onDone(null);
  };
  return (
    <input
      className="sidebar-name-input"
      aria-label={props.label}
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={key}
      onBlur={() => props.onDone(value.trim() || null)}
    />
  );
}

/** 放进某个图库文件夹的图：图片墙按图库给出每张图的来源，只取它在这个库里的来源（#112）。 */
export function droppedImages(e: DragEvent, libraryId: string): string[] {
  const sources = e.dataTransfer.getData(DRAG_IMAGE_SOURCES);
  return sources
    ? (JSON.parse(sources) as Record<string, string[] | undefined>)[libraryId] ?? []
    : JSON.parse(e.dataTransfer.getData(DRAG_IMAGES) || "[]") as string[];
}

export const acceptsDrag = (e: DragEvent) =>
  e.dataTransfer.types.includes(DRAG_IMAGES) || e.dataTransfer.types.includes(DRAG_FOLDER);

/**
 * 一个图库在侧栏里展开后的内容（方案 D）：未归类与文件夹树，计数只算可见的图。
 * 双击文件夹改名；把文件夹拖到同库的另一个文件夹上移进去；把图片墙上选中的图拖到文件夹上放进去。
 */
export function SidebarPane({ libraryId, libraryName, scope, scopeSelected, onScope, onError, directory, unassigned, descendantCounts, includeDescendants = false, creating, parentForNew, onCreatingDone }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const run = (p: Promise<unknown>) => p.catch((e) => onError(String(e)));

  const created = (name: string | null) => {
    onCreatingDone();
    if (name) void run(createFolder(libraryId, name, parentForNew));
  };

  const over = (target: string) => (e: DragEvent) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    setDropTarget(target);
  };

  const drop = (folderId: string) => (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const folder = e.dataTransfer.getData(DRAG_FOLDER);
    if (folder) {
      const from = e.dataTransfer.getData(DRAG_FOLDER_LIBRARY);
      if (folder !== folderId && (!from || from === libraryId)) void run(moveFolder(libraryId, folder, folderId, LAST));
      return;
    }
    const images = droppedImages(e, libraryId);
    if (images.length) void run(editImages(libraryId, images, [{ kind: "addToFolder", folderId }]));
  };

  const count = (node: FolderNode) => includeDescendants ? descendantCounts?.[node.id] ?? node.count : node.count;
  const current = (target: BrowseScope) => scopeSelected && same(scope, target) ? "page" as const : undefined;

  // Rows join one fluid-hover list in visible (pre-order) order.
  let row = 0;
  const tree = (nodes: FolderNode[], depth = 0) => (
    <ul role="group" className="sidebar-tree">
      {nodes.map((node) => (
        <li key={node.id} role="treeitem" aria-label={node.name}>
          {renaming === node.id ? (
            <NameInput
              label="文件夹名称"
              initial={node.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== node.name) void run(renameFolder(libraryId, node.id, name));
              }}
            />
          ) : (
            <FluidRow index={row++}>
            <button
              type="button"
              data-folder-id={node.id}
              className="sidebar-item k-row"
              style={{ paddingLeft: 8 + depth * 16 }}
              data-drop={dropTarget === node.id || undefined}
              aria-current={current({ kind: "folder", id: node.id })}
              aria-label={`${node.name}（${count(node)} 张）`}
              draggable
              onClick={() => onScope({ kind: "folder", id: node.id })}
              onDoubleClick={() => setRenaming(node.id)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_FOLDER, node.id);
                e.dataTransfer.setData(DRAG_FOLDER_LIBRARY, libraryId);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={over(node.id)}
              onDragLeave={() => setDropTarget(null)}
              onDrop={drop(node.id)}
              title="双击改名；拖到别的文件夹上移进去"
            >
              <span className="k-row-icon" aria-hidden="true">{node.children.length > 0 ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
              <span className="sidebar-label">{node.name}</span>
              <span className="sidebar-count">{count(node)}</span>
            </button>
            </FluidRow>
          )}
          {node.children.length > 0 && tree(node.children, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav className="sidebar" aria-label={`${libraryName}的目录`}>
      <FluidList>
      {unassigned !== undefined && <FluidRow index={row++}>
        <button type="button" className="sidebar-item k-row" aria-current={current({ kind: "unassigned" })}
          aria-label={`未归类（${unassigned} 张）`} onClick={() => onScope({ kind: "unassigned" })}>
          <span className="k-row-icon" aria-hidden="true"><Inbox size={15} /></span>
          <span className="sidebar-label">未归类</span>
          <span className="sidebar-count">{unassigned}</span>
        </button>
      </FluidRow>}
      <div role="tree" aria-label="文件夹" className="sidebar-folders">
        {tree(directory.folders)}
        {creating && <NameInput label="新文件夹名称" initial="" onDone={created} />}
      </div>
      </FluidList>
    </nav>
  );
}
