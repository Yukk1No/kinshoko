import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import type { BrowseScope } from "../bindings/BrowseScope";
import type { FolderNode } from "../bindings/FolderNode";
import type { Sidebar } from "../bindings/Sidebar";
import { createFolder, editImages, moveFolder, renameFolder, sidebar } from "../ipc";
import { DRAG_IMAGES } from "../wall/Wall";

/** 侧栏里拖动文件夹时放进 dataTransfer 的类型，值为文件夹 id。 */
const DRAG_FOLDER = "application/x-kinshoko-folder";
/** 移动文件夹时放到新位置的最后。 */
const LAST = 2 ** 31;

type Props = {
  scope: BrowseScope;
  onScope: (scope: BrowseScope) => void;
  /** 资料库报告列表过期时递增：重新取侧栏。 */
  reloadKey: number;
  onError: (message: string) => void;
};

const same = (a: BrowseScope, b: BrowseScope) =>
  a.kind === b.kind && (a.kind !== "folder" || (b.kind === "folder" && a.id === b.id));

/** 只在文本框里按 Enter 提交、Esc 放弃。 */
function NameInput(props: {
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

/**
 * 侧栏：全部、文件夹树与回收站，计数只算可见的图。
 * 双击文件夹改名；把文件夹拖到另一个文件夹上移进去，拖到“文件夹”标题上移到顶层；
 * 把图片墙上选中的图拖到文件夹上放进去。
 */
export function SidebarPane({ scope, onScope, reloadKey, onError }: Props) {
  const [data, setData] = useState<Sidebar | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    sidebar().then(
      (value) => alive && setData(value),
      (e) => alive && onError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [reloadKey, onError]);

  const run = (p: Promise<unknown>) => p.catch((e) => onError(String(e)));

  // 新建的文件夹放在当前打开的文件夹里，否则放在顶层。
  const parentForNew = scope.kind === "folder" ? scope.id : null;
  const created = (name: string | null) => {
    setCreating(false);
    if (name) void run(createFolder(name, parentForNew));
  };

  const accepts = (e: DragEvent) =>
    e.dataTransfer.types.includes(DRAG_IMAGES) || e.dataTransfer.types.includes(DRAG_FOLDER);

  const over = (target: string) => (e: DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    setDropTarget(target);
  };

  /** 放到文件夹 folderId 上；null 表示“文件夹”标题（顶层）。 */
  const drop = (folderId: string | null) => (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    const folder = e.dataTransfer.getData(DRAG_FOLDER);
    if (folder) {
      if (folder !== folderId) void run(moveFolder(folder, folderId, LAST));
      return;
    }
    const images = e.dataTransfer.getData(DRAG_IMAGES);
    if (images && folderId) {
      void run(editImages(JSON.parse(images) as string[], [{ kind: "addToFolder", folderId }]));
    }
  };

  const item = (target: BrowseScope, label: string, count: number | undefined) => (
    <button
      type="button"
      className="sidebar-item"
      aria-current={same(scope, target) ? "page" : undefined}
      aria-label={count === undefined ? label : `${label}（${count} 张）`}
      onClick={() => onScope(target)}
    >
      <span className="sidebar-label">{label}</span>
      <span className="sidebar-count">{count ?? ""}</span>
    </button>
  );

  const tree = (nodes: FolderNode[]) => (
    <ul role="group" className="sidebar-tree">
      {nodes.map((node) => (
        <li key={node.id} role="treeitem" aria-label={node.name}>
          {renaming === node.id ? (
            <NameInput
              label="文件夹名称"
              initial={node.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== node.name) void run(renameFolder(node.id, name));
              }}
            />
          ) : (
            <button
              type="button"
              className="sidebar-item"
              data-drop={dropTarget === node.id || undefined}
              aria-current={same(scope, { kind: "folder", id: node.id }) ? "page" : undefined}
              aria-label={`${node.name}（${node.count} 张）`}
              draggable
              onClick={() => onScope({ kind: "folder", id: node.id })}
              onDoubleClick={() => setRenaming(node.id)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_FOLDER, node.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={over(node.id)}
              onDragLeave={() => setDropTarget(null)}
              onDrop={drop(node.id)}
              title="双击改名；拖到别的文件夹上移进去"
            >
              <span className="sidebar-label">{node.name}</span>
              <span className="sidebar-count">{node.count}</span>
            </button>
          )}
          {node.children.length > 0 && tree(node.children)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav className="sidebar" aria-label="侧栏">
      {item({ kind: "all" }, "全部", data?.all)}
      <div
        className="sidebar-heading"
        data-drop={dropTarget === "" || undefined}
        onDragOver={over("")}
        onDragLeave={() => setDropTarget(null)}
        onDrop={drop(null)}
      >
        <span>文件夹</span>
        <button
          type="button"
          className="sidebar-add"
          aria-label="新建文件夹"
          title={parentForNew ? "在当前文件夹里新建" : "新建文件夹"}
          onClick={() => setCreating(true)}
        >
          ＋
        </button>
      </div>
      <div role="tree" aria-label="文件夹" className="sidebar-folders">
        {data && tree(data.folders)}
        {creating && <NameInput label="新文件夹名称" initial="" onDone={created} />}
      </div>
      {item({ kind: "trash" }, "回收站", data?.trash)}
    </nav>
  );
}
