import type { WorkspaceSource } from "../bindings/WorkspaceSource";
import type { LibraryRegistration } from "../bindings/LibraryRegistration";
import { WorkspaceSourceEditor } from "./WorkspaceSourceEditor";
import { Segmented } from "../ui/Segmented";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderPlus, Images, Layers, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { FluidList, FluidRow } from "../ui/FluidList";
import { Menu, MenuItem, MenuPopup } from "../ui/Menu";
import { Switch } from "../ui/Switch";
import type { WorkspaceDirectories } from "../bindings/WorkspaceDirectories";
import type { WorkspaceDirectory } from "../bindings/WorkspaceDirectory";
import type { FolderNode } from "../bindings/FolderNode";
import { isCursorExpired, isLensChanged, moveFolder, workspaceDirectories } from "../ipc";
import { acceptsDrag, DRAG_FOLDER, DRAG_FOLDER_LIBRARY, LAST, SidebarPane } from "./SidebarPane";
import { libraryPathHint } from "./library-path";
import type { WorkspaceCard } from "../bindings/WorkspaceCard";
import type { WorkspaceScope } from "../bindings/WorkspaceScope";
import type { WorkspaceStatus } from "../bindings/WorkspaceStatus";

/** 拖动悬停在折起的图库上多久后自动展开（弹簧加载，方案 D）。 */
export const SPRING_OPEN_MS = 600;

function folderPath(nodes: FolderNode[], id: string, parent: string[] = []): string[] | null {
  for (const node of nodes) {
    const path = [...parent, node.name];
    if (node.id === id) return path;
    const found = folderPath(node.children, id, path);
    if (found) return found;
  }
  return null;
}

/**
 * 图库标题的操作（`⋯`）。#114 在这里补上在资源管理器中打开、重新连接与从列表移除，
 * 并让图库标题的右键菜单使用同一组菜单项。
 */
function LibraryMenuItems({ provider, onNewFolder }: { provider: WorkspaceDirectory; onNewFolder: () => void }) {
  return <MenuItem icon={<FolderPlus size={14} />} disabled={!provider.sidebar} onClick={onNewFolder}>新建文件夹</MenuItem>;
}

/** 回收站行：选中某库时是该库的回收站，选“全部图片”时是各库合计（ADR-0008）。 */
function TrashRow({ label, count, current, expanded, disabled, onClick }: {
  label: string; count: number | undefined; current?: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <FluidList><FluidRow index={0}>
    <button type="button" className="sidebar-item k-row" aria-current={current ? "page" : undefined} aria-expanded={expanded}
      disabled={disabled} aria-label={`回收站 · ${label}（${count ?? "…"} 张）`} onClick={onClick}>
      <span className="k-row-icon" aria-hidden="true"><Trash2 size={15} /></span>
      <span className="sidebar-label">回收站<span className="lib-dim"> · {label}</span></span>
      <span className="sidebar-count">{count ?? ""}</span>
    </button>
  </FluidRow></FluidList>;
}

/**
 * 侧栏（方案 D，#113；design/ui-system/README.md 侧栏布局）：顶部固定“全部图片”与跨库合计；中间是
 * Finder 式的图库分组，选中哪个图库内的范围就只展开哪个，选“全部图片”时全部折起，箭头可临时多展开；
 * 拖动图片或文件夹悬停在折起的图库上约 0.6 秒自动展开，放下或离开后恢复。每个已连接图库的目录都能
 * 直接整理（ADR-0008）；未连接的图库只占一行并可就地重新连接。底部固定 `foot`（自动打标）与跟随所选
 * 图库的回收站。
 */
export function WorkspacePane({ status, scope, onScope, safeMode, reloadKey, onError, onRecheck, foot, children }: {
  status: WorkspaceStatus | null; scope: WorkspaceScope; onScope: (scope: WorkspaceScope) => void;
  safeMode: boolean; reloadKey: number; onError: (message: string) => void;
  /** 重新检查未连接的图库（移动盘接回后）。 */
  onRecheck?: () => void;
  foot?: ReactNode;
  children?: ReactNode;
}) {
  const key = JSON.stringify([status?.revision, safeMode, reloadKey]);
  const [loaded, setLoaded] = useState<{ key: string; forest: WorkspaceDirectories } | null>(null);
  const [descendants, setDescendants] = useState(!(scope.kind === "library" && scope.scope.kind === "folder"));
  useEffect(() => {
    let alive = true;
    const load = async () => {
      for (let attempt = 0; alive; attempt++) {
        try {
          const forest = await workspaceDirectories(safeMode);
          if (alive) setLoaded({ key, forest });
          return;
        } catch (error) {
          if (!alive || isLensChanged(error)) return;
          if (isCursorExpired(error) && attempt < 3) continue;
          onError(String(error));
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

  // A changed safety/provider revision hides old controls before a new request can complete.
  const forest = loaded?.key === key ? loaded.forest : null;
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
          <span className="sidebar-label">全部图片</span><span className="sidebar-count">{total ?? ""}</span></button>
      </FluidRow></FluidList>
    </div>
    <div className="side-scroll">
    {providers.map((provider) => {
      const { registration: { library, unavailable }, sidebar, unassigned, descendants: counts } = provider;
      const available = !unavailable && Boolean(sidebar);
      const expanded = available && (openIds.has(library.id) || sprung === library.id);
      const selectedRoot = scope.kind === "library" && scope.libraryId === library.id;
      const parentForNew = selectedRoot && (scope.scope.kind === "folder" || scope.scope.kind === "folderTree") ? scope.scope.id : null;
      const dropFolderHere = (e: DragEvent) => {
        const folder = e.dataTransfer.getData(DRAG_FOLDER);
        const from = e.dataTransfer.getData(DRAG_FOLDER_LIBRARY);
        if (!folder || (from && from !== library.id)) return;
        void moveFolder(library.id, folder, null, LAST).catch((error) => onError(String(error)));
      };
      return <section key={library.id} className="workspace-provider lib-group" data-library-id={library.id}
        data-offline={unavailable ? "true" : undefined} {...springHandlers(library.id, available && !expanded)}>
        <div className="workspace-provider-root lib-head">
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
            <span className="sidebar-label">{library.name}</span>
            {unavailable ? <span className="lib-dot is-off" aria-hidden="true" /> : <span className="sidebar-count">{sidebar?.all ?? "…"}</span>}
          </button>
          <Menu.Root modal={false}>
            <Menu.Trigger className="k-icon-btn lib-more" aria-label={`${library.name} 的操作`} title="图库操作">
              <MoreHorizontal size={14} aria-hidden="true" />
            </Menu.Trigger>
            <MenuPopup width={200} label={`${library.name} 的操作`}>
              <LibraryMenuItems provider={provider} onNewFolder={() => { toggle(library.id, true); setCreatingIn(library.id); }} />
            </MenuPopup>
          </Menu.Root>
        </div>
        {unavailable && <div className="lib-offline" role="status" title={unavailable}>
          未连接 · 移动盘接回后可用{onRecheck && <> · <button type="button" className="offline-retry" onClick={onRecheck}><RefreshCw size={11} aria-hidden="true" />重新连接</button></>}
        </div>}
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
      <span aria-hidden="true">含子文件夹</span>
    </div>
    {children}
    </div>
    <div className="side-foot">
      {foot}
      {scope.kind === "library" ? selected && <TrashRow label={selected.registration.library.name} count={selected.sidebar?.trash}
        current={scope.scope.kind === "trash"} disabled={!selected.sidebar} onClick={() => onScope(trashOf(selected.registration.library.id))} />
      : <>
        <TrashRow label="全部图库" count={trashTotal} disabled={connected.length === 0} expanded={connected.length > 1 ? trashList : undefined}
          onClick={() => connected.length === 1 ? onScope(trashOf(connected[0].registration.library.id)) : setTrashList((open) => !open)} />
        {trashList && connected.length > 1 && <div role="group" aria-label="各图库的回收站" className="trash-groups">
          <FluidList>{connected.map((p, index) => <FluidRow key={p.registration.library.id} index={index}>
            <button type="button" className="sidebar-item k-row trash-group-row" aria-label={`${p.registration.library.name}（${p.sidebar?.trash ?? 0} 张）`}
              title={p.registration.library.root} onClick={() => onScope(trashOf(p.registration.library.id))}>
              <span className="sidebar-label">{p.registration.library.name}</span>
              <span className="sidebar-count">{p.sidebar?.trash ?? 0}</span>
            </button>
          </FluidRow>)}</FluidList>
        </div>}
      </>}
    </div>
  </nav>;
}

/**
 * 详情面板里的多来源整理（#98）：同一文件在 N 个图库各自保留整理结果。先明确选一份来源，
 * 再用分段切换在来源之间换；标签、分级、文件夹与备注都只改所选的那一份。
 */
export function WorkspaceSources({ card, onClose, onView, safe = true, reloadKey = 0, onChanged, registrations = [] }: {
  card: WorkspaceCard; onClose: () => void; onView: (card: WorkspaceCard) => void;
  safe?: boolean; reloadKey?: number; onChanged?: () => void; registrations?: LibraryRegistration[];
}) {
  const [editing, setEditing] = useState<WorkspaceSource | null>(null);
  const keyOf = (source: WorkspaceSource) => source.libraryId + "/" + source.imageId;
  const root = (id: string) => registrations.find((r) => r.library.id === id)?.library.root;
  const hint = (id: string) => root(id) ? libraryPathHint(root(id)!, registrations.map((r) => r.library.root)) : undefined;
  return <section className="workspace-sources" aria-label="图库来源"
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
    <div className="insp-sec">
      <h4><Layers size={13} aria-hidden="true" />{card.sources.length > 1 ? `在 ${card.sources.length} 个图库` : "所在图库"}<span className="insp-h-hint">各自整理</span></h4>
      <Segmented label="当前操作的来源记录" value={editing ? keyOf(editing) : null}
        onChange={(key) => { const next = card.sources.find((s) => keyOf(s) === key); if (next) setEditing(next); }}
        options={card.sources.map((source) => ({ value: keyOf(source), label: source.libraryName, disabled: !!source.unavailable,
          title: [hint(source.libraryId), source.deleted ? "回收站" : null, source.unavailable ? "未连接" : null].filter(Boolean).join(" · ") || undefined }))} />
    </div>
    {editing && <WorkspaceSourceEditor key={keyOf(editing)} card={card} source={editing}
      safe={safe} registrations={registrations} reloadKey={reloadKey} onSource={setEditing} onClose={onClose} onChanged={onChanged} />}
    {!editing && <ul className="workspace-source-list">{card.sources.map((source) => <li key={keyOf(source)} data-source-library-id={source.libraryId} title={keyOf(source)}>
      <div className="workspace-source-head">
        <strong>{source.libraryName}</strong>
        <span className="workspace-source-state">{source.deleted ? "回收站" : source.matches ? "符合当前查找" : "不符合当前查找"}</span>
      </div>
      {root(source.libraryId) && <span className="workspace-source-path" title={root(source.libraryId)}>{hint(source.libraryId)}</span>}
      {source.unavailable ? <p className="insp-hint" role="status">{source.unavailable}</p> :
        <div className="selection-actions"><button type="button" className="k-btn is-sm" onClick={() => setEditing(source)}>整理此来源</button>
        <button type="button" className="k-btn is-sm" onClick={() => { onClose(); onView({ ...card, libraryId: source.libraryId, imageId: source.imageId }); }}>查看此来源</button></div>}
    </li>)}</ul>}
  </section>;
}
