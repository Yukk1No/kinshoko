import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Images, MoreHorizontal, Trash2 } from "lucide-react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { FluidList, FluidRow } from "../ui/FluidList";
import { Menu, MenuItem, MenuPopup } from "../ui/Menu";
import { PermanentDeleteConfirm } from "./SelectionPanel";
import { Switch } from "../ui/Switch";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import { isCursorExpired, isLensChanged, moveFolder, revealLibrary, unregisterLibrary, workspaceDirectories } from "../ipc";
import { acceptsDrag, DRAG_FOLDER, DRAG_FOLDER_LIBRARY, LAST, SidebarPane } from "./SidebarPane";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";
import { folderPath, LibraryMenuItems, TrashRow } from "./WorkspacePaneRows";
// 来源整理拆到 WorkspaceSources.tsx；从这里导入的调用方照旧可用。
export { WorkspaceSources } from "./WorkspaceSources";

/** 拖动悬停在折起的图库上多久后自动展开（弹簧加载，方案 D）。 */
export const SPRING_OPEN_MS = 600;

/**
 * 侧栏（方案 D，#113；design/ui-system/README.md 侧栏布局）：顶部固定“全部图片”与跨库合计；中间是
 * Finder 式的图库分组，选中哪个图库内的范围就只展开哪个，选“全部图片”时全部折起，箭头可临时多展开；
 * 拖动图片或文件夹悬停在折起的图库上约 0.6 秒自动展开，放下或离开后恢复。每个已连接图库的目录都能
 * 直接整理（ADR-0008）；未连接的图库只占一行并可就地重新连接。底部固定跟随所选图库的回收站。
 */
export function WorkspacePane({ status, scope, onScope, safeMode, reloadKey, onError, onRecheck, onRemoved, children }: {
  status: WorkspaceStatus | null; scope: WorkspaceScope; onScope: (scope: WorkspaceScope) => void;
  safeMode: boolean; reloadKey: number; onError: (error: unknown) => void;
  /** 重新检查未连接的图库（移动盘接回后）。 */
  onRecheck?: () => void;
  /** 图库标题菜单“从列表移除”完成后（取消登记，文件不删）。 */
  onRemoved?: (libraryId: string) => void;
  children?: ReactNode;
}) {
  // 代次（登记了哪些图库、各自是否可用、安全模式）变了，旧目录在新结果到达前就不再显示。内容变化
  // （status.revision 随每次进库前进，导入期间约每 1.5 秒一次）与单纯重读（reloadKey，每次列表过期加一）
  // 只重读：沿用上一份目录直到新结果到达，资料库行不因计数刷新整行变成不可用（#121）。
  const generation = JSON.stringify([status?.libraries, safeMode]);
  const key = JSON.stringify([generation, status?.revision, reloadKey]);
  const [loaded, setLoaded] = useState<{ generation: string; forest: WorkspaceDirectories } | null>(null);
  const [descendants, setDescendants] = useState(!(scope.kind === "library" && scope.scope.kind === "folder"));
  useEffect(() => {
    let alive = true;
    const load = async () => {
      for (let attempt = 0; alive; attempt++) {
        try {
          const forest = await workspaceDirectories(safeMode);
          if (alive) setLoaded({ generation, forest });
          return;
        } catch (error) {
          if (!alive || isLensChanged(error)) return;
          if (isCursorExpired(error) && attempt < 3) continue;
          onError(error);
          return;
        }
      }
    };
    void load();
    return () => { alive = false; };
  }, [key, safeMode, onError]);

  // 展开规则：选中某库内的范围时只展开该库，选“全部图片”时全部折起；所选图库变了才重置，
  // 期间点箭头的临时展开保留。在渲染中比较而不用 effect，换库的这一帧就不闪出旧的展开。
  const selectedLibrary = scope.kind === "library" ? scope.libraryId : null;
  const [opened, setOpened] = useState(() => ({ for: selectedLibrary, ids: new Set(selectedLibrary ? [selectedLibrary] : []) }));
  let openIds = opened.ids;
  if (opened.for !== selectedLibrary) {
    openIds = new Set(selectedLibrary ? [selectedLibrary] : []);
    setOpened({ for: selectedLibrary, ids: openIds });
  }
  const toggle = (id: string, open: boolean) => setOpened((previous) => {
    const ids = new Set(previous.ids);
    if (open) ids.add(id); else ids.delete(id);
    return { ...previous, ids };
  });

  // 弹簧加载：拖动悬停在折起的图库上 SPRING_OPEN_MS 后临时展开；离开该图库、放下或拖动结束时收回。
  // 进出用计数而不用 relatedTarget：子元素之间移动时 dragenter 先于 dragleave。
  const [sprung, setSprung] = useState<string | null>(null);
  const spring = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const depth = useRef(new Map<string, number>());
  const stopSpring = () => {
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
  };
  useEffect(() => {
    const end = () => {
      if (spring.current) clearTimeout(spring.current.timer);
      spring.current = null;
      depth.current.clear();
      setSprung(null);
    };
    window.addEventListener("drop", end);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("drop", end);
      window.removeEventListener("dragend", end);
      if (spring.current) clearTimeout(spring.current.timer);
    };
  }, []);

  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [headDrop, setHeadDrop] = useState<string | null>(null);
  const [trashList, setTrashList] = useState(false);
  /** 正在确认清空回收站的图库。 */
  const [emptying, setEmptying] = useState<{ libraryId: string; name: string } | null>(null);
  const reveal = (libraryId: string) => { revealLibrary(libraryId).catch((e) => onError(`无法在资源管理器中打开：${String(e)}`)); };
  // 移除完成时按那时的范围判断：正浏览这个图库（任一范围）就回到“全部图片”（同时清掉选择），
  // 不再向已取消登记的图库请求浏览。
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const remove = (libraryId: string) => { unregisterLibrary(libraryId).then(() => {
    const current = latestScope.current;
    if (current.kind === "library" && current.libraryId === libraryId) onScope({ kind: "all" });
    onRemoved?.(libraryId);
  }, (e) => onError(e)); };
  const emptyItem = (p: WorkspaceDirectory, label: string) => <MenuItem key={p.registration.library.id} icon={<Trash2 size={14} />} danger
    disabled={!p.sidebar || p.sidebar.trash === 0} onClick={() => setEmptying({ libraryId: p.registration.library.id, name: p.registration.library.name })}>{label}</MenuItem>;

  // A changed safety/provider revision hides old controls before a new request can complete.
  const forest = loaded?.generation === generation ? loaded.forest : null;
  const providers = forest?.providers ?? status?.libraries.map((registration) => ({ registration, sidebar: null, unassigned: 0, descendants: {} })) ?? [];
  const connected = providers.filter((p) => !p.registration.unavailable && p.sidebar);
  const selected = scope.kind === "library" ? providers.find((p) => p.registration.library.id === scope.libraryId) : undefined;
  const local = scope.kind === "library" ? scope.scope : null;
  const isFolder = local?.kind === "folder" || local?.kind === "folderTree";
  const path = isFolder && selected?.sidebar ? folderPath(selected.sidebar.folders, local.id) : null;
  const range = scope.kind === "all" ? "全部图库" : selected ? selected.registration.library.name + " / " +
    (selected.registration.unavailable ? "未连接" : isFolder ? path?.join(" / ") ?? (forest ? "文件夹已失效" : "正在读取目录") : local?.kind === "trash" ? "回收站" : local?.kind === "unassigned" ? "未归类" : "全部图片") : forest ? "图库已失效" : "正在读取图库";
  const total = forest ? connected.reduce((sum, p) => sum + (p.sidebar?.all ?? 0), 0) : undefined;
  const trashTotal = forest ? connected.reduce((sum, p) => sum + (p.sidebar?.trash ?? 0), 0) : undefined;
  const trashOf = (id: string): WorkspaceScope => ({ kind: "library", libraryId: id, scope: { kind: "trash" } });

  const springHandlers = (id: string, closed: boolean) => ({
    onDragEnter: (e: DragEvent) => {
      if (!acceptsDrag(e)) return;
      depth.current.set(id, (depth.current.get(id) ?? 0) + 1);
      if (!closed || spring.current?.id === id) return;
      stopSpring();
      spring.current = { id, timer: setTimeout(() => { spring.current = null; setSprung(id); }, SPRING_OPEN_MS) };
    },
    onDragLeave: () => {
      const left = (depth.current.get(id) ?? 1) - 1;
      if (left > 0) { depth.current.set(id, left); return; }
      depth.current.delete(id);
      if (spring.current?.id === id) stopSpring();
      setSprung((current) => current === id ? null : current);
    },
  });

  return <nav className="workspace-scope side-bands" aria-label="查找范围">
    <div className="workspace-current-scope sr-only" role="status">范围：{range}</div>
    <div className="side-top">
      <FluidList><FluidRow index={0}>
        <button type="button" className="sidebar-item k-row" aria-current={scope.kind === "all" ? "page" : undefined}
          aria-label={total === undefined ? "全部图片" : `全部图片（${total} 张）`}
          onClick={() => onScope({ kind: "all" })}><span className="k-row-icon" aria-hidden="true"><Images size={15} /></span>
          <span className="sidebar-label k-label">全部图片</span><span className="sidebar-count k-label">{total ?? ""}</span></button>
      </FluidRow></FluidList>
    </div>
    <div className="side-scroll">
    {providers.map((provider) => {
      const { registration: { library, unavailable }, sidebar, unassigned, descendants: counts } = provider;
      const available = !unavailable && Boolean(sidebar);
      const expanded = available && (openIds.has(library.id) || sprung === library.id);
      const selectedRoot = scope.kind === "library" && scope.libraryId === library.id;
      const parentForNew = selectedRoot && (scope.scope.kind === "folder" || scope.scope.kind === "folderTree") ? scope.scope.id : null;
      const libraryItems = <LibraryMenuItems provider={provider} onNewFolder={() => { toggle(library.id, true); setCreatingIn(library.id); }}
        onReveal={() => reveal(library.id)} onRecheck={onRecheck} onRemove={() => remove(library.id)} />;
      const dropFolderHere = (e: DragEvent) => {
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        const from = e.dataTransfer.getData(DRAG_FOLDER_LIBRARY);
        if (!folder || (from && from !== library.id)) return;
        void moveFolder(library.id, folder, null, LAST).catch((error) => onError(error));
      };
      return <section key={library.id} className="workspace-provider lib-group" data-library-id={library.id}
        data-offline={unavailable ? "true" : undefined} {...springHandlers(library.id, available && !expanded)}>
        <ContextMenu.Root>
        {/* 图库标题的右键菜单与 ⋯ 同一组菜单项；未连接时名称按钮禁用（不接收指针），右键落在这一行上。 */}
        <ContextMenu.Trigger render={<div className="workspace-provider-root lib-head" title={unavailable ? `${library.root}\n${unavailable}` : undefined} />}>
          {available ? <button type="button" className="workspace-expand" aria-label={`${expanded ? "收起" : "展开"}${library.name}`}
            aria-expanded={expanded} onClick={() => {
              if (sprung === library.id) setSprung(null);
              toggle(library.id, !expanded);
            }}>{expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button>
            : <span className="workspace-expand" aria-hidden="true" />}
          <button type="button" className={`sidebar-item lib-head-name${unavailable ? " is-off" : ""}`} disabled={!available}
            aria-label={unavailable ? library.name + "（未连接）" : `${library.name}（${sidebar?.all ?? "…"} 张）`}
            aria-current={selectedRoot && scope.scope.kind === "all" ? "page" : undefined}
            data-drop={headDrop === library.id || undefined}
            onDragOver={(e) => { if (available && e.dataTransfer.types.includes(DRAG_FOLDER)) { e.preventDefault(); setHeadDrop(library.id); } }}
            onDragLeave={() => setHeadDrop(null)}
            onDrop={(e) => { e.preventDefault(); setHeadDrop(null); dropFolderHere(e); }}
            onClick={() => onScope({ kind: "library", libraryId: library.id, scope: { kind: "all" } })}
            title={unavailable ? `${library.root}\n${unavailable}` : library.root}>
            <span className="sidebar-label k-label">{library.name}</span>
            {unavailable ? <span className="lib-dot is-off" aria-hidden="true" /> : <span className="sidebar-count k-label">{sidebar?.all ?? "…"}</span>}
          </button>
          {unavailable && onRecheck && <button type="button" className="offline-retry" title={unavailable} onClick={onRecheck}><span className="k-label">重新连接</span></button>}
          <Menu.Root modal={false}>
            <Menu.Trigger className="k-icon-btn lib-more" aria-label={`${library.name} 的操作`} title="图库操作">
              <MoreHorizontal size={14} aria-hidden="true" />
            </Menu.Trigger>
            <MenuPopup width={200} label={`${library.name} 的操作`}>
              {libraryItems}
            </MenuPopup>
          </Menu.Root>
        </ContextMenu.Trigger>
        <MenuPopup width={200} label={`${library.name} 的操作`}>{libraryItems}</MenuPopup>
        </ContextMenu.Root>
        {expanded && sidebar && <SidebarPane directory={sidebar} unassigned={unassigned} descendantCounts={counts} includeDescendants={descendants}
          libraryName={library.name} libraryId={library.id}
          scopeSelected={selectedRoot} scope={selectedRoot ? scope.scope : { kind: "all" }}
          creating={creatingIn === library.id} parentForNew={parentForNew} onCreatingDone={() => setCreatingIn(null)}
          onScope={(next) => onScope({ kind: "library", libraryId: library.id, scope: next.kind === "folder" || next.kind === "folderTree" ? { kind: descendants ? "folderTree" : "folder", id: next.id } : next })}
          onError={onError} />}
      </section>;
    })}
    <div className="sub-toggle workspace-descendants">
      <Switch size="sm" label="含子文件夹" checked={isFolder ? local.kind === "folderTree" : descendants}
        disabled={!isFolder || !path || Boolean(selected?.registration.unavailable)}
        onCheckedChange={(checked) => {
          if (!isFolder || scope.kind !== "library") return;
          setDescendants(checked); onScope({ ...scope, scope: { kind: checked ? "folderTree" : "folder", id: local.id } });
        }} />
      <span className="k-label" aria-hidden="true">含子文件夹</span>
    </div>
    {children}
    </div>
    <div className="side-foot">
      {scope.kind === "library" ? selected && <TrashRow label={selected.registration.library.name} count={selected.sidebar?.trash}
        current={scope.scope.kind === "trash"} disabled={!selected.sidebar} onClick={() => onScope(trashOf(selected.registration.library.id))}
        menu={emptyItem(selected, "清空回收站…")} />
      : <>
        <TrashRow label="全部图库" count={trashTotal} disabled={connected.length === 0} expanded={connected.length > 1 ? trashList : undefined}
          onClick={() => connected.length === 1 ? onScope(trashOf(connected[0].registration.library.id)) : setTrashList((open) => !open)}
          menu={connected.map((p) => emptyItem(p, connected.length === 1 ? "清空回收站…" : `清空「${p.registration.library.name}」的回收站…`))} />
        {trashList && connected.length > 1 && <div role="group" aria-label="各图库的回收站" className="trash-groups">
          <FluidList>{connected.map((p, index) => <FluidRow key={p.registration.library.id} index={index}>
            <button type="button" className="sidebar-item k-row trash-group-row" aria-label={`${p.registration.library.name}（${p.sidebar?.trash ?? 0} 张）`}
              title={p.registration.library.root} onClick={() => onScope(trashOf(p.registration.library.id))}>
              <span className="sidebar-label k-label">{p.registration.library.name}</span>
              <span className="sidebar-count k-label">{p.sidebar?.trash ?? 0}</span>
            </button>
          </FluidRow>)}</FluidList>
        </div>}
      </>}
    </div>
    {emptying && <PermanentDeleteConfirm libraryId={emptying.libraryId} ids={[]} emptyTrash={{ libraryName: emptying.name }}
      onDone={() => setEmptying(null)} onCancel={() => setEmptying(null)} onError={onError} />}
  </nav>;
}
